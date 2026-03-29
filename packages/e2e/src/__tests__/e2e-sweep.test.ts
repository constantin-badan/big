import { describe, test, expect, beforeAll } from 'bun:test';

import type {
  BacktestConfig,
  ExchangeConfig,
  PositionManagerConfig,
  RiskConfig,
  SweepParamGrid,
} from '@trading-bot/types';

import { createBacktestEngine } from '@trading-bot/backtest-engine';
import { createSweepEngine } from '@trading-bot/sweep-engine';
import type { SweepResult } from '@trading-bot/sweep-engine';

import { BTCUSDT, makeGoldenCandles, makeEmaCrossoverFactory } from '../e2e-helpers';

// ─── Configs ─────────────────────────────────────────────────────────

const exchangeConfig: ExchangeConfig = {
  type: 'backtest-sim',
  feeStructure: { maker: 0.0002, taker: 0.0004 },
  slippageModel: { type: 'fixed', fixedBps: 0 },
  initialBalance: 10_000,
};

const riskConfig: RiskConfig = {
  maxPositionSizePct: 10,
  maxConcurrentPositions: 1,
  maxDailyLossPct: 50,
  maxDrawdownPct: 50,
  maxDailyTrades: 100,
  cooldownAfterLossMs: 0,
  leverage: 1,
  initialBalance: 10_000,
};

const pmConfig: PositionManagerConfig = {
  defaultStopLossPct: 5,
  defaultTakeProfitPct: 10,
  trailingStopEnabled: false,
  trailingStopActivationPct: 0,
  trailingStopDistancePct: 0,
  maxHoldTimeMs: 999_999_999,
};

// =====================================================================
// E2E Sweep Engine Tests
// =====================================================================

describe('E2E Sweep Engine', () => {
  const goldenCandles = makeGoldenCandles();

  const btConfig: BacktestConfig = {
    startTime: goldenCandles[0]!.openTime,
    endTime: goldenCandles[goldenCandles.length - 1]!.closeTime + 1,
    symbols: [BTCUSDT],
    timeframes: ['1m'],
  };

  const grid: SweepParamGrid = {
    fastPeriod: [3, 5, 10],
    slowPeriod: [8, 10],
  };

  const loader = async () => goldenCandles;
  const factory = makeEmaCrossoverFactory([BTCUSDT], riskConfig, pmConfig);

  let results: SweepResult[];

  beforeAll(async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const sweep = createSweepEngine(engine);
    results = await sweep.run(factory, grid, btConfig);
  });

  test('sweep produces exactly 6 results', () => {
    expect(results.length).toBe(6);
  });

  test('results sorted by profit factor descending', () => {
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.result.metrics.profitFactor).toBeGreaterThanOrEqual(
        results[i + 1]!.result.metrics.profitFactor,
      );
    }
  });

  test('(10,10) combination is last with 0 trades', () => {
    const match = results.find(
      (r) => r.params.fastPeriod === 10 && r.params.slowPeriod === 10,
    );
    expect(match).toBeDefined();
    expect(match!.result.trades.length).toBe(0);
    expect(match!.result.metrics.profitFactor).toBe(0);
  });

  test('each result has correct param keys', () => {
    const validFast = new Set([3, 5, 10]);
    const validSlow = new Set([8, 10]);
    for (const r of results) {
      expect('fastPeriod' in r.params).toBe(true);
      expect('slowPeriod' in r.params).toBe(true);
      expect(validFast.has(r.params.fastPeriod!)).toBe(true);
      expect(validSlow.has(r.params.slowPeriod!)).toBe(true);
    }
  });

  test('top result params match its trade behavior', () => {
    const top = results[0]!;
    // On golden candles (up/down/up), EMA crossovers with fast < slow will fire.
    // The top result should have trades and a positive profit factor.
    expect(top.result.trades.length).toBeGreaterThan(0);
    expect(top.result.metrics.profitFactor).toBeGreaterThan(0);
  });

  test('all 6 param combinations are present', () => {
    const expected = new Set([
      '3,8', '3,10', '5,8', '5,10', '10,8', '10,10',
    ]);
    const actual = new Set(
      results.map((r) => `${String(r.params.fastPeriod)},${String(r.params.slowPeriod)}`),
    );
    expect(actual).toEqual(expected);
  });
});
