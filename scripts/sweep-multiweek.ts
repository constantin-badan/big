#!/usr/bin/env bun
/**
 * Run the same parameter sweep across 10 random non-overlapping weeks.
 * Tests whether the best params generalize or are overfit to one period.
 *
 * Usage:
 *   bun run scripts/sweep-multiweek.ts
 */
import { toSymbol } from '@trading-bot/types';
import type { Symbol, Timeframe, ExchangeConfig, BacktestConfig, PositionManagerConfig, RiskConfig, SweepParamGrid } from '@trading-bot/types';
import { createStorage } from '@trading-bot/storage';
import { createBacktestEngine } from '@trading-bot/backtest-engine';
import { createSweepEngine } from '@trading-bot/sweep-engine';
import type { SweepResult } from '@trading-bot/sweep-engine';

import { createEmaCrossoverFactory } from '../strategies/ema-crossover';

// ─── Configuration ──────────────────────────────────────────────────

const DB_PATH = './data/candles.db';

const SYMBOLS: Symbol[] = [
  toSymbol('BTCUSDT'),
  toSymbol('ETHUSDT'),
  toSymbol('SOLUSDT'),
  toSymbol('BNBUSDT'),
];

const TIMEFRAME: Timeframe = '5m';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NUM_WEEKS = 10;
const WARMUP_CANDLES = 50;

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

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

// ─── Week Selection ─────────────────────────────────────────────────

function selectRandomWeeks(dataStart: number, dataEnd: number, count: number): Array<{ start: number; end: number }> {
  const totalRange = dataEnd - dataStart;
  if (totalRange < count * WEEK_MS) {
    throw new Error(`Not enough data for ${String(count)} non-overlapping weeks. Have ${String(Math.floor(totalRange / WEEK_MS))} weeks of data.`);
  }

  // Divide the data range into count equal slices, pick one week from each
  const sliceSize = Math.floor(totalRange / count);
  const weeks: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < count; i++) {
    const sliceStart = dataStart + i * sliceSize;
    const maxWeekStart = sliceStart + sliceSize - WEEK_MS;
    // Deterministic "random" offset within each slice (seeded by index)
    const offset = Math.floor((sliceSize - WEEK_MS) * ((i * 7 + 3) % 11) / 11);
    const weekStart = Math.min(sliceStart + offset, maxWeekStart);
    const weekEnd = weekStart + WEEK_MS;
    weeks.push({ start: weekStart, end: weekEnd });
  }

  return weeks;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tfMs = TIMEFRAME_MS[TIMEFRAME];
  if (!tfMs) throw new Error(`Unknown timeframe: ${TIMEFRAME}`);

  const { candles: store } = createStorage(DB_PATH);

  // Find data range from storage
  const earliest = store.getEarliestTimestamp(SYMBOLS[0]!, TIMEFRAME);
  const latest = store.getLatestTimestamp(SYMBOLS[0]!, TIMEFRAME);
  if (earliest === null || latest === null) {
    console.error('No data found. Run sync.ts first.');
    process.exit(1);
  }

  const warmupMs = WARMUP_CANDLES * tfMs;
  const weeks = selectRandomWeeks(earliest + warmupMs, latest, NUM_WEEKS);

  console.log('=== Multi-Week Sweep: EMA Crossover ===');
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Timeframe: ${TIMEFRAME}`);
  console.log(`Grid: ${String((grid.fastPeriod?.length ?? 0) * (grid.slowPeriod?.length ?? 0))} combinations`);
  console.log(`Testing across ${String(NUM_WEEKS)} weeks:`);
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i]!;
    console.log(`  Week ${String(i + 1)}: ${new Date(w.start).toISOString().slice(0, 10)} → ${new Date(w.end).toISOString().slice(0, 10)}`);
  }
  console.log('');

  const loader = (symbol: Symbol, tf: Timeframe, start: number, end: number) =>
    Promise.resolve(store.getCandles(symbol, tf, start, end));

  const factory = createEmaCrossoverFactory(SYMBOLS, TIMEFRAME, riskConfig, pmConfig);

  // Track per-param performance across all weeks
  const paramKey = (params: Record<string, number>): string =>
    `${String(params.fastPeriod ?? 0)},${String(params.slowPeriod ?? 0)}`;

  const aggregated = new Map<string, {
    params: Record<string, number>;
    totalPnl: number;
    totalTrades: number;
    profitableWeeks: number;
    weekResults: Array<{ week: number; pf: number; trades: number; pnl: number }>;
  }>();

  const startMs = Date.now();

  for (let w = 0; w < weeks.length; w++) {
    const week = weeks[w]!;
    const btConfig: BacktestConfig = {
      startTime: week.start,
      endTime: week.end,
      symbols: SYMBOLS,
      timeframes: [TIMEFRAME],
    };

    const engine = createBacktestEngine(loader, exchangeConfig);
    const sweep = createSweepEngine(engine);
    const results = await sweep.run(factory, grid, btConfig);

    for (const r of results) {
      const key = paramKey(r.params);
      let entry = aggregated.get(key);
      if (!entry) {
        entry = { params: r.params, totalPnl: 0, totalTrades: 0, profitableWeeks: 0, weekResults: [] };
        aggregated.set(key, entry);
      }
      const weekPnl = r.result.finalBalance - r.result.initialBalance;
      entry.totalPnl += weekPnl;
      entry.totalTrades += r.result.metrics.totalTrades;
      if (weekPnl > 0) entry.profitableWeeks += 1;
      entry.weekResults.push({
        week: w + 1,
        pf: r.result.metrics.profitFactor,
        trades: r.result.metrics.totalTrades,
        pnl: weekPnl,
      });
    }

    console.log(`  Week ${String(w + 1)} complete (${String(results.length)} combos)`);
  }

  const elapsed = Date.now() - startMs;
  console.log(`\nCompleted in ${String(elapsed)}ms\n`);

  // Sort by total PnL across all weeks
  const sorted = [...aggregated.values()].sort((a, b) => b.totalPnl - a.totalPnl);

  // Print results
  console.log('=== Aggregated Results (sorted by total PnL across all weeks) ===\n');
  console.log(
    'Rank  Fast  Slow  TotalPnL  Trades  ProfWeeks  AvgPnL/Wk  Consistency',
  );
  console.log(
    '────  ────  ────  ────────  ──────  ─────────  ─────────  ───────────',
  );

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    const rank = String(i + 1).padStart(4);
    const fast = String(s.params.fastPeriod ?? '?').padStart(4);
    const slow = String(s.params.slowPeriod ?? '?').padStart(4);
    const totalPnl = s.totalPnl.toFixed(2).padStart(8);
    const trades = String(s.totalTrades).padStart(6);
    const profWeeks = `${String(s.profitableWeeks)}/${String(NUM_WEEKS)}`.padStart(9);
    const avgPnl = (s.totalPnl / NUM_WEEKS).toFixed(2).padStart(9);
    const consistency = `${((s.profitableWeeks / NUM_WEEKS) * 100).toFixed(0)}%`.padStart(11);

    console.log(
      `${rank}  ${fast}  ${slow}  ${totalPnl}  ${trades}  ${profWeeks}  ${avgPnl}  ${consistency}`,
    );
  }

  // Top 3 detail
  console.log('\n=== Top 3 — Per-Week Breakdown ===\n');
  for (let i = 0; i < Math.min(3, sorted.length); i++) {
    const s = sorted[i]!;
    console.log(`#${String(i + 1)} fast=${String(s.params.fastPeriod)} slow=${String(s.params.slowPeriod)} (total PnL: ${s.totalPnl.toFixed(2)})`);
    for (const wr of s.weekResults) {
      const marker = wr.pnl > 0 ? '+' : wr.pnl < 0 ? '-' : '=';
      console.log(`  Week ${String(wr.week).padStart(2)}: ${marker} PnL=${wr.pnl.toFixed(2).padStart(8)}  trades=${String(wr.trades).padStart(3)}  PF=${wr.pf === Infinity ? 'Inf' : wr.pf.toFixed(2)}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('Multi-week sweep failed:', err);
  process.exit(1);
});
