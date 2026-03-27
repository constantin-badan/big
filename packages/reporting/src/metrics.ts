import type { TradeRecord, Timeframe, PerformanceMetrics } from '@trading-bot/types';
import { KahanSum } from './kahan';

const PERIODS_PER_YEAR: Record<Timeframe, number> = {
  '1m': 525_600,
  '3m': 175_200,
  '5m': 105_120,
  '15m': 35_040,
  '1h': 8_760,
  '4h': 2_190,
  '1d': 365,
};

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

function getFinestTimeframe(timeframes: Timeframe[]): Timeframe {
  let finest: Timeframe = timeframes[0] ?? '1d';
  let maxPeriods = PERIODS_PER_YEAR[finest];
  for (const tf of timeframes) {
    const periods = PERIODS_PER_YEAR[tf];
    if (periods > maxPeriods) {
      maxPeriods = periods;
      finest = tf;
    }
  }
  return finest;
}

function periodDurationMs(tf: Timeframe): number {
  return Math.round(MS_PER_YEAR / PERIODS_PER_YEAR[tf]);
}

export function computeMetrics(
  trades: TradeRecord[],
  timeframes: Timeframe[],
  initialBalance: number,
  startTime: number,
  endTime: number,
): PerformanceMetrics {
  const zero: PerformanceMetrics = {
    totalTrades: 0,
    winRate: 0,
    profitFactor: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    maxDrawdownDuration: 0,
    avgWin: 0,
    avgLoss: 0,
    expectancy: 0,
    avgHoldTime: 0,
    totalFees: 0,
    totalSlippage: 0,
  };

  if (trades.length === 0) {
    return zero;
  }

  const totalTrades = trades.length;

  // Sort trades by exitTime for equity-curve construction
  const sorted = trades.slice().sort((a, b) => a.exitTime - b.exitTime);

  // Basic accumulators
  const feesSum = new KahanSum();
  const slippageSum = new KahanSum();
  const grossProfitSum = new KahanSum();
  const grossLossSum = new KahanSum();
  const winPnlSum = new KahanSum();
  const lossPnlSum = new KahanSum();
  const holdTimeSum = new KahanSum();
  const pnlSum = new KahanSum();

  let wins = 0;
  let losses = 0;

  for (const trade of sorted) {
    feesSum.add(trade.fees);
    slippageSum.add(trade.slippage);
    holdTimeSum.add(trade.holdTimeMs);
    pnlSum.add(trade.pnl);

    if (trade.pnl > 0) {
      wins += 1;
      grossProfitSum.add(trade.pnl);
      winPnlSum.add(trade.pnl);
    } else if (trade.pnl < 0) {
      losses += 1;
      grossLossSum.add(-trade.pnl); // store as positive
      lossPnlSum.add(trade.pnl);
    }
  }

  const totalFees = feesSum.value;
  const totalSlippage = slippageSum.value;
  const winRate = wins / totalTrades;
  const avgHoldTime = holdTimeSum.value / totalTrades;
  const expectancy = pnlSum.value / totalTrades;
  const avgWin = wins > 0 ? winPnlSum.value / wins : 0;
  const avgLoss = losses > 0 ? lossPnlSum.value / losses : 0;

  let profitFactor: number;
  if (wins === 0 && losses === 0) {
    profitFactor = 0;
  } else if (losses === 0) {
    profitFactor = Infinity;
  } else {
    profitFactor = grossProfitSum.value / grossLossSum.value;
  }

  // Build equity curve for drawdown and Sharpe
  const equityPoints: { time: number; balance: number }[] = [
    { time: startTime, balance: initialBalance },
  ];

  let runningBalance = initialBalance;
  for (const trade of sorted) {
    runningBalance += trade.pnl;
    equityPoints.push({ time: trade.exitTime, balance: runningBalance });
  }

  // Max drawdown
  let maxDrawdown = 0;
  let peakBalance = initialBalance;
  let peakTime = startTime;
  let maxDrawdownDuration = 0;
  let inDrawdown = false;

  for (const point of equityPoints) {
    if (point.balance >= peakBalance) {
      // New peak — check duration of previous drawdown period
      if (inDrawdown) {
        const duration = point.time - peakTime;
        if (duration > maxDrawdownDuration) {
          maxDrawdownDuration = duration;
        }
        inDrawdown = false;
      }
      peakBalance = point.balance;
      peakTime = point.time;
    } else {
      inDrawdown = true;
      const drawdown = ((peakBalance - point.balance) / peakBalance) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  // Check if we're still in a drawdown at end of backtest
  if (runningBalance < peakBalance) {
    const duration = endTime - peakTime;
    if (duration > maxDrawdownDuration) {
      maxDrawdownDuration = duration;
    }
  }

  // Sharpe ratio — bucket equity curve into periods
  const tf = timeframes.length > 0 ? getFinestTimeframe(timeframes) : '1d';
  const periodMs = periodDurationMs(tf);
  const periodsPerYear = PERIODS_PER_YEAR[tf];

  // Build period buckets: for each period bucket, what is the ending balance?
  // We assign each trade's pnl to the period it falls in by exitTime.
  const firstPeriod = Math.floor(startTime / periodMs);
  const lastPeriod = Math.floor(endTime / periodMs);
  const numPeriods = lastPeriod - firstPeriod + 1;

  // Build an ordered list of period-end balances
  const periodBalances: number[] = [];

  let balanceAtPeriodStart = initialBalance;
  let tradeIdx = 0;

  for (let p = 0; p < numPeriods; p++) {
    const periodEnd = (firstPeriod + p + 1) * periodMs;
    const periodKahan = new KahanSum();
    periodKahan.add(balanceAtPeriodStart);

    while (tradeIdx < sorted.length) {
      const trade = sorted[tradeIdx];
      if (trade === undefined || trade.exitTime >= periodEnd) {
        break;
      }
      periodKahan.add(trade.pnl);
      tradeIdx += 1;
    }

    periodBalances.push(periodKahan.value);
    balanceAtPeriodStart = periodKahan.value;
  }

  // Compute per-period returns
  const returns: number[] = [];
  for (let i = 1; i < periodBalances.length; i++) {
    const prev = periodBalances[i - 1];
    const curr = periodBalances[i];
    if (prev !== undefined && curr !== undefined && prev !== 0) {
      returns.push((curr - prev) / prev);
    }
  }

  let sharpeRatio = 0;
  if (returns.length >= 2) {
    const meanKahan = new KahanSum();
    for (const r of returns) {
      meanKahan.add(r);
    }
    const mean = meanKahan.value / returns.length;

    const varianceKahan = new KahanSum();
    for (const r of returns) {
      const diff = r - mean;
      varianceKahan.add(diff * diff);
    }
    const variance = varianceKahan.value / (returns.length - 1); // Bessel's correction (sample std dev)
    const stddev = Math.sqrt(variance);

    if (stddev !== 0) {
      sharpeRatio = (mean / stddev) * Math.sqrt(periodsPerYear);
    }
  }

  return {
    totalTrades,
    winRate,
    profitFactor,
    sharpeRatio,
    maxDrawdown,
    maxDrawdownDuration,
    avgWin,
    avgLoss,
    expectancy,
    avgHoldTime,
    totalFees,
    totalSlippage,
  };
}
