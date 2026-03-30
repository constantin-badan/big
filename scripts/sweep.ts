#!/usr/bin/env bun
/**
 * Thin wrapper — single-period EMA crossover sweep.
 * Usage: bun run scripts/sweep.ts
 */
import { toSymbol } from '@trading-bot/types';
import type { Symbol, Timeframe, ExchangeConfig, BacktestConfig, PositionManagerConfig, RiskConfig, SweepParamGrid } from '@trading-bot/types';
import { createStorage } from '@trading-bot/storage';
import { createBacktestEngine } from '@trading-bot/backtest-engine';
import { createSweepEngine } from '@trading-bot/sweep-engine';
import { createEmaCrossoverFactory } from '@trading-bot/strategies';

const DB_PATH = './data/candles.db';

const SYMBOLS: Symbol[] = [
  toSymbol('BTCUSDT'),
  toSymbol('ETHUSDT'),
  toSymbol('SOLUSDT'),
  toSymbol('BNBUSDT'),
];

const TIMEFRAME: Timeframe = '5m';
const LOOKBACK_DAYS = 5;
const WARMUP_CANDLES = 50;

const grid: SweepParamGrid = {
  fastPeriod: [3, 5, 8, 12, 20],
  slowPeriod: [10, 15, 20, 30, 50],
};

const exchangeConfig: ExchangeConfig = {
  type: 'backtest-sim',
  feeStructure: { maker: 0.0002, taker: 0.0004 },
  slippageModel: { type: 'fixed', fixedBps: 5 },
  initialBalance: 10_000,
};

const riskConfig: RiskConfig = {
  maxPositionSizePct: 5,
  maxConcurrentPositions: 2,
  maxDailyLossPct: 3,
  maxDrawdownPct: 15,
  maxDailyTrades: 50,
  cooldownAfterLossMs: 300_000,
  leverage: 1,
  initialBalance: 10_000,
};

const pmConfig: PositionManagerConfig = {
  defaultStopLossPct: 2,
  defaultTakeProfitPct: 4,
  trailingStopEnabled: false,
  trailingStopActivationPct: 0,
  trailingStopDistancePct: 0,
  maxHoldTimeMs: 4 * 60 * 60 * 1000,
};

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

async function main(): Promise<void> {
  const tfMs = TIMEFRAME_MS[TIMEFRAME];
  if (!tfMs) throw new Error(`Unknown timeframe: ${TIMEFRAME}`);

  const endTime = Date.now();
  const backtestStart = endTime - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const warmupMs = WARMUP_CANDLES * tfMs;
  const dataStart = backtestStart - warmupMs;

  console.log('=== EMA Crossover Sweep ===');
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Timeframe: ${TIMEFRAME}`);
  console.log(`Backtest: ${new Date(backtestStart).toISOString()} -> ${new Date(endTime).toISOString()}`);
  console.log(`Warmup: ${String(WARMUP_CANDLES)} candles (data from ${new Date(dataStart).toISOString()})`);
  console.log(`Grid: fastPeriod=${JSON.stringify(grid.fastPeriod)} slowPeriod=${JSON.stringify(grid.slowPeriod)}`);

  const fastCount = grid.fastPeriod?.length ?? 0;
  const slowCount = grid.slowPeriod?.length ?? 0;
  console.log(`Combinations: ${String(fastCount * slowCount)}`);
  console.log('');

  const { candles: store } = createStorage(DB_PATH);

  const loader = (symbol: Symbol, tf: Timeframe, start: number, end: number) =>
    Promise.resolve(store.getCandles(symbol, tf, start, end));

  for (const symbol of SYMBOLS) {
    const earliest = store.getEarliestTimestamp(symbol, TIMEFRAME);
    const latest = store.getLatestTimestamp(symbol, TIMEFRAME);
    if (earliest === null || latest === null) {
      console.error(`No data for ${String(symbol)} ${TIMEFRAME}. Run sync.ts first.`);
      process.exit(1);
    }
    const candleCount = store.getCandles(symbol, TIMEFRAME, dataStart, endTime).length;
    console.log(`  ${String(symbol)}: ${String(candleCount)} candles (${new Date(earliest).toISOString()} -> ${new Date(latest).toISOString()})`);
  }
  console.log('');

  const factory = createEmaCrossoverFactory(SYMBOLS, TIMEFRAME, riskConfig, pmConfig);

  const btConfig: BacktestConfig = {
    startTime: backtestStart,
    endTime,
    symbols: SYMBOLS,
    timeframes: [TIMEFRAME],
  };

  const engine = createBacktestEngine(loader, exchangeConfig);
  const sweep = createSweepEngine(engine);

  console.log('Running sweep...');
  const startMs = Date.now();
  const results = await sweep.run(factory, grid, btConfig);
  const elapsed = Date.now() - startMs;

  console.log(`Completed in ${String(elapsed)}ms`);
  console.log('');

  console.log('=== Results (sorted by profit factor) ===');
  console.log('');
  console.log(
    'Rank  Fast  Slow  Trades  WinRate  PF      Sharpe  MaxDD    Expectancy  FinalBal',
  );
  console.log(
    '----  ----  ----  ------  -------  ------  ------  -------  ----------  --------',
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const m = r.result.metrics;
    const fast = String(r.params.fastPeriod ?? '?').padStart(4);
    const slow = String(r.params.slowPeriod ?? '?').padStart(4);
    const rank = String(i + 1).padStart(4);
    const trades = String(m.totalTrades).padStart(6);
    const winRate = (m.winRate * 100).toFixed(1).padStart(6) + '%';
    const pf = m.profitFactor === Infinity ? '   Inf' : m.profitFactor.toFixed(2).padStart(6);
    const sharpe = m.sharpeRatio.toFixed(2).padStart(6);
    const maxDD = m.maxDrawdown.toFixed(1).padStart(6) + '%';
    const exp = m.expectancy.toFixed(2).padStart(10);
    const bal = r.result.finalBalance.toFixed(0).padStart(8);

    console.log(
      `${rank}  ${fast}  ${slow}  ${trades}  ${winRate}  ${pf}  ${sharpe}  ${maxDD}  ${exp}  ${bal}`,
    );
  }

  console.log('');
  const profitable = results.filter((r) => r.result.finalBalance > r.result.initialBalance);
  console.log(`${String(profitable.length)}/${String(results.length)} combinations profitable`);

  if (results.length > 0) {
    const best = results[0]!;
    console.log(`Best: fast=${String(best.params.fastPeriod)} slow=${String(best.params.slowPeriod)} PF=${best.result.metrics.profitFactor.toFixed(2)} Sharpe=${best.result.metrics.sharpeRatio.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
