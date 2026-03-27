import type { IBacktestEngine } from '@trading-bot/backtest-engine';
import type { ITradeStore } from '@trading-bot/storage';
import type { StrategyFactory } from '@trading-bot/strategy';
import type { BacktestConfig, Timeframe, TradeRecord } from '@trading-bot/types';

import type {
  IParityChecker,
  ParityMatchedPair,
  ParityResult,
  ParitySummary,
} from './types';

// Timeframe durations in ms — for match tolerance
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

function bpsDiff(live: number, backtest: number): number {
  if (backtest === 0) return 0;
  return ((live - backtest) / backtest) * 10_000;
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Match live trades against backtest trades using fuzzy key:
 * (symbol, side, entryTime ± tolerance)
 *
 * Tolerance = finest candle period from the timeframes array.
 */
function matchTrades(
  liveTrades: TradeRecord[],
  backtestTrades: TradeRecord[],
  toleranceMs: number,
): { matched: ParityMatchedPair[]; liveOnly: TradeRecord[]; backtestOnly: TradeRecord[] } {
  const matched: ParityMatchedPair[] = [];
  const usedBacktest = new Set<number>();
  const unmatchedLive: TradeRecord[] = [];

  for (const live of liveTrades) {
    let bestIdx = -1;
    let bestTimeDiff = Infinity;

    for (let i = 0; i < backtestTrades.length; i++) {
      if (usedBacktest.has(i)) continue;
      const bt = backtestTrades[i]!;

      if (bt.symbol !== live.symbol) continue;
      if (bt.side !== live.side) continue;

      const timeDiff = Math.abs(live.entryTime - bt.entryTime);
      if (timeDiff <= toleranceMs && timeDiff < bestTimeDiff) {
        bestIdx = i;
        bestTimeDiff = timeDiff;
      }
    }

    if (bestIdx >= 0) {
      const bt = backtestTrades[bestIdx]!;
      usedBacktest.add(bestIdx);
      matched.push({
        live,
        backtest: bt,
        entryPriceDiffBps: bpsDiff(live.entryPrice, bt.entryPrice),
        exitPriceDiffBps: bpsDiff(live.exitPrice, bt.exitPrice),
        pnlDiff: live.pnl - bt.pnl,
        slippageDiff: live.slippage - bt.slippage,
        feeDiff: live.fees - bt.fees,
        exitReasonMatch: live.exitReason === bt.exitReason,
      });
    } else {
      unmatchedLive.push(live);
    }
  }

  const backtestOnly: TradeRecord[] = [];
  for (let i = 0; i < backtestTrades.length; i++) {
    if (!usedBacktest.has(i)) {
      backtestOnly.push(backtestTrades[i]!);
    }
  }

  return { matched, liveOnly: unmatchedLive, backtestOnly };
}

function computeSummary(
  matched: ParityMatchedPair[],
  totalUnique: number,
): ParitySummary {
  if (matched.length === 0) {
    return {
      matchRate: 0,
      meanEntryDeviationBps: 0,
      meanPnlDeviation: 0,
      pnlCorrelation: 0,
      backtestOverestimatesPnl: false,
    };
  }

  let sumEntryBps = 0;
  let sumPnlDiff = 0;
  const livePnls: number[] = [];
  const btPnls: number[] = [];

  for (const m of matched) {
    sumEntryBps += m.entryPriceDiffBps;
    sumPnlDiff += m.pnlDiff;
    livePnls.push(m.live.pnl);
    btPnls.push(m.backtest.pnl);
  }

  const meanEntryDeviationBps = sumEntryBps / matched.length;
  const meanPnlDeviation = sumPnlDiff / matched.length;

  return {
    matchRate: totalUnique > 0 ? matched.length / totalUnique : 0,
    meanEntryDeviationBps,
    meanPnlDeviation,
    pnlCorrelation: pearsonCorrelation(livePnls, btPnls),
    // Negative meanPnlDeviation means live PnL < backtest PnL → backtest overestimates
    backtestOverestimatesPnl: meanPnlDeviation < 0,
  };
}

export function createParityChecker(
  engine: IBacktestEngine,
  tradeStore: ITradeStore,
  timeframes: Timeframe[],
): IParityChecker {
  // Use finest timeframe for match tolerance
  const toleranceMs = Math.min(
    ...timeframes.map((tf) => TIMEFRAME_MS[tf] ?? 60_000),
  );

  return {
    async compare(
      strategyName: string,
      factory: StrategyFactory,
      params: Record<string, number>,
      period: { startTime: number; endTime: number },
    ): Promise<ParityResult> {
      // 1. Read live trades from store
      const liveTrades = tradeStore.getTrades({
        strategyName,
        startTime: period.startTime,
        endTime: period.endTime,
      });

      // 2. Run backtest over the same period
      const backtestConfig: BacktestConfig = {
        startTime: period.startTime,
        endTime: period.endTime,
        symbols: [...new Set(liveTrades.map((t) => t.symbol))],
        timeframes,
      };

      const backtestResult = await engine.run(factory, params, backtestConfig);

      // 3. Match trades
      const { matched, liveOnly, backtestOnly } = matchTrades(
        liveTrades,
        backtestResult.trades,
        toleranceMs,
      );

      // 4. Compute summary
      const totalUnique = matched.length + liveOnly.length + backtestOnly.length;
      const summary = computeSummary(matched, totalUnique);

      return {
        period,
        matched,
        liveOnly,
        backtestOnly,
        summary,
      };
    },
  };
}
