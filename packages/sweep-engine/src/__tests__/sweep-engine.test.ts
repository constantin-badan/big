import { describe, test, expect } from 'bun:test';

import type { IBacktestEngine } from '@trading-bot/backtest-engine';
import type { StrategyFactory, SweepParamGrid } from '@trading-bot/strategy';
import type { BacktestConfig, BacktestResult, PerformanceMetrics } from '@trading-bot/types';

import { createSweepEngine } from '../sweep-engine';

const BASE_TIME = 1700000000000;

const btConfig: BacktestConfig = {
  startTime: BASE_TIME,
  endTime: BASE_TIME + 100 * 60_000,
  symbols: ['BTCUSDT'],
  timeframes: ['1m'],
};

const zeroMetrics: PerformanceMetrics = {
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

function makeResult(profitFactor: number): BacktestResult {
  return {
    trades: [],
    startTime: BASE_TIME,
    endTime: BASE_TIME + 100 * 60_000,
    initialBalance: 10_000,
    finalBalance: 10_000,
    metrics: { ...zeroMetrics, profitFactor },
  };
}

// Mock engine that records params it was called with and returns results
// based on a deterministic function of the params
function createMockEngine(): {
  engine: IBacktestEngine;
  calls: Array<Record<string, number>>;
} {
  const calls: Array<Record<string, number>> = [];
  const engine: IBacktestEngine = {
    async run(_factory, params) {
      calls.push(params);
      // Use sum of param values as profit factor for deterministic ordering
      let sum = 0;
      for (const v of Object.values(params)) {
        sum += v;
      }
      return makeResult(sum);
    },
  };
  return { engine, calls };
}

const dummyFactory: StrategyFactory = (_params, _deps) => ({
  name: 'dummy',
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  getStats: () => zeroMetrics,
});

describe('createSweepEngine', () => {
  test('grid { a: [1, 2], b: [3, 4] } produces 4 runs with correct params', async () => {
    const { engine, calls } = createMockEngine();
    const sweep = createSweepEngine(engine);

    const grid: SweepParamGrid = { a: [1, 2], b: [3, 4] };
    const results = await sweep.run(dummyFactory, grid, btConfig);

    expect(calls.length).toBe(4);
    expect(results.length).toBe(4);

    const paramSets = calls.map((c) => `${c['a']},${c['b']}`);
    expect(paramSets).toContain('1,3');
    expect(paramSets).toContain('1,4');
    expect(paramSets).toContain('2,3');
    expect(paramSets).toContain('2,4');
  });

  test('results sorted by profitFactor descending', async () => {
    const { engine } = createMockEngine();
    const sweep = createSweepEngine(engine);

    const grid: SweepParamGrid = { a: [1, 2, 3], b: [10, 20] };
    const results = await sweep.run(dummyFactory, grid, btConfig);

    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1]!.result.metrics.profitFactor;
      const curr = results[i]!.result.metrics.profitFactor;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }

    // Best should be a=3, b=20 → pf=23
    expect(results[0]!.params['a']).toBe(3);
    expect(results[0]!.params['b']).toBe(20);
  });

  test('empty grid returns empty results', async () => {
    const { engine, calls } = createMockEngine();
    const sweep = createSweepEngine(engine);

    const results = await sweep.run(dummyFactory, {}, btConfig);

    expect(results.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  test('single-value grid produces single run', async () => {
    const { engine, calls } = createMockEngine();
    const sweep = createSweepEngine(engine);

    const grid: SweepParamGrid = { a: [42] };
    const results = await sweep.run(dummyFactory, grid, btConfig);

    expect(results.length).toBe(1);
    expect(calls.length).toBe(1);
    expect(results[0]!.params['a']).toBe(42);
  });

  test('params are passed through to engine.run', async () => {
    const { engine, calls } = createMockEngine();
    const sweep = createSweepEngine(engine);

    const grid: SweepParamGrid = { fast: [5, 10], slow: [20, 30] };
    await sweep.run(dummyFactory, grid, btConfig);

    for (const call of calls) {
      expect(typeof call['fast']).toBe('number');
      expect(typeof call['slow']).toBe('number');
    }
  });

  test('grid with empty values array returns empty results', async () => {
    const { engine, calls } = createMockEngine();
    const sweep = createSweepEngine(engine);

    const grid: SweepParamGrid = { a: [1, 2], b: [] };
    const results = await sweep.run(dummyFactory, grid, btConfig);

    expect(results.length).toBe(0);
    expect(calls.length).toBe(0);
  });
});
