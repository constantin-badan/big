import { describe, test, expect, mock } from 'bun:test';

import type { ArenaRanking, IArena } from '@trading-bot/arena';
import type { PerformanceMetrics } from '@trading-bot/types';

import { Evolver } from '../evolver';
import { clampAndSnap, gaussianRandom, mutateParams } from '../mutation';
import type { EvolverConfig, EvolverScorer } from '../types';

const ZERO_METRICS: PerformanceMetrics = {
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

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return { ...ZERO_METRICS, ...overrides };
}

function makeRanking(
  params: Record<string, number>,
  metricsOverrides: Partial<PerformanceMetrics> = {},
): ArenaRanking {
  return {
    params,
    metrics: makeMetrics(metricsOverrides),
    trades: [],
  };
}

// ── gaussianRandom ──────────────────────────────────────────────────────

describe('gaussianRandom', () => {
  test('returns finite numbers', () => {
    for (let i = 0; i < 1000; i++) {
      const val = gaussianRandom();
      expect(Number.isFinite(val)).toBe(true);
    }
  });

  test('has approximately zero mean over many samples', () => {
    let sum = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      sum += gaussianRandom();
    }
    const mean = sum / n;
    // Mean should be close to 0 (within 0.1 for 10k samples)
    expect(Math.abs(mean)).toBeLessThan(0.1);
  });

  test('has approximately unit variance over many samples', () => {
    const values: number[] = [];
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      values.push(gaussianRandom());
    }
    let sum = 0;
    for (const v of values) {
      sum += v;
    }
    const mean = sum / n;

    let varianceSum = 0;
    for (const v of values) {
      varianceSum += (v - mean) ** 2;
    }
    const variance = varianceSum / n;
    // Variance should be close to 1 (within 0.2 for 10k samples)
    expect(variance).toBeGreaterThan(0.8);
    expect(variance).toBeLessThan(1.2);
  });
});

// ── clampAndSnap ────────────────────────────────────────────────────────

describe('clampAndSnap', () => {
  test('clamps below min', () => {
    expect(clampAndSnap(-5, { min: 0, max: 100 })).toBe(0);
  });

  test('clamps above max', () => {
    expect(clampAndSnap(150, { min: 0, max: 100 })).toBe(100);
  });

  test('passes through values within range (no step)', () => {
    expect(clampAndSnap(42.7, { min: 0, max: 100 })).toBe(42.7);
  });

  test('snaps to integer step', () => {
    expect(clampAndSnap(4.7, { min: 0, max: 10, step: 1 })).toBe(5);
    expect(clampAndSnap(4.3, { min: 0, max: 10, step: 1 })).toBe(4);
  });

  test('snaps to step grid relative to min', () => {
    // min=2, step=3 → valid values: 2, 5, 8, 11, ...
    expect(clampAndSnap(6.1, { min: 2, max: 20, step: 3 })).toBe(5);
    expect(clampAndSnap(7.0, { min: 2, max: 20, step: 3 })).toBe(8);
  });

  test('snaps and re-clamps when rounding pushes past max', () => {
    // min=0, max=10, step=3 → valid: 0, 3, 6, 9
    // 9.8 rounds to 9 (nearest step), which is within max
    expect(clampAndSnap(9.8, { min: 0, max: 10, step: 3 })).toBe(9);
  });

  test('handles step=0.001 for percentage precision', () => {
    const result = clampAndSnap(0.0547, { min: 0, max: 1, step: 0.001 });
    expect(Math.abs(result - 0.055)).toBeLessThan(1e-10);
  });

  test('value exactly at min', () => {
    expect(clampAndSnap(0, { min: 0, max: 100, step: 5 })).toBe(0);
  });

  test('value exactly at max', () => {
    expect(clampAndSnap(100, { min: 0, max: 100, step: 5 })).toBe(100);
  });
});

// ── mutateParams ────────────────────────────────────────────────────────

describe('mutateParams', () => {
  test('mutated params stay within bounds', () => {
    const params = { fast: 10, slow: 50, threshold: 0.05 };
    const bounds = {
      fast: { min: 2, max: 20, step: 1 },
      slow: { min: 10, max: 100, step: 1 },
      threshold: { min: 0.01, max: 0.5, step: 0.001 },
    };

    for (let i = 0; i < 1000; i++) {
      const mutated = mutateParams(params, bounds, 0.2);
      const fastVal = mutated['fast']!;
      const slowVal = mutated['slow']!;
      const thresholdVal = mutated['threshold']!;

      expect(fastVal).toBeGreaterThanOrEqual(2);
      expect(fastVal).toBeLessThanOrEqual(20);
      expect(Number.isInteger(fastVal)).toBe(true);

      expect(slowVal).toBeGreaterThanOrEqual(10);
      expect(slowVal).toBeLessThanOrEqual(100);
      expect(Number.isInteger(slowVal)).toBe(true);

      expect(thresholdVal).toBeGreaterThanOrEqual(0.01);
      expect(thresholdVal).toBeLessThanOrEqual(0.5);
    }
  });

  test('passes through params without bounds unchanged', () => {
    const params = { a: 5, unknown: 99 };
    const bounds = { a: { min: 0, max: 10 } };

    const mutated = mutateParams(params, bounds, 0.1);
    expect(mutated['unknown']).toBe(99);
  });

  test('returns a new object (does not mutate input)', () => {
    const params = { a: 5 };
    const bounds = { a: { min: 0, max: 10 } };

    const mutated = mutateParams(params, bounds, 0.1);
    expect(mutated).not.toBe(params);
  });

  test('with zero mutation rate, values stay close to original', () => {
    // With mutationRate=0, gaussian(0,0) = 0, so no change
    const params = { x: 5 };
    const bounds = { x: { min: 0, max: 10 } };

    const mutated = mutateParams(params, bounds, 0);
    expect(mutated['x']).toBe(5);
  });

  test('handles zero-valued params (additive mutation)', () => {
    const params = { x: 0 };
    const bounds = { x: { min: -10, max: 10 } };

    // Run many times — zero-valued params use additive mutation from center of range
    let allZero = true;
    for (let i = 0; i < 100; i++) {
      const mutated = mutateParams(params, bounds, 0.5);
      if (mutated['x'] !== 0) {
        allZero = false;
        break;
      }
    }
    // With additive mutation, we should escape zero at least once in 100 trials
    expect(allZero).toBe(false);
  });

  test('preserves all param keys', () => {
    const params = { a: 1, b: 2, c: 3 };
    const bounds = {
      a: { min: 0, max: 10 },
      b: { min: 0, max: 10 },
      c: { min: 0, max: 10 },
    };

    const mutated = mutateParams(params, bounds, 0.1);
    expect(Object.keys(mutated).sort()).toEqual(['a', 'b', 'c']);
  });
});

// ── Evolver class ───────────────────────────────────────────────────────

function createMockArena(): {
  arena: IArena;
  rankings: ArenaRanking[];
  addedInstances: Record<string, number>[];
  removedInstances: Record<string, number>[];
  startMock: ReturnType<typeof mock>;
  stopMock: ReturnType<typeof mock>;
} {
  const rankings: ArenaRanking[] = [];
  const addedInstances: Record<string, number>[] = [];
  const removedInstances: Record<string, number>[] = [];
  const startMock = mock(() => Promise.resolve());
  const stopMock = mock(() => Promise.resolve());

  const arena: IArena = {
    start: startMock,
    stop: stopMock,
    getRankings: () => [...rankings],
    addInstance: (params) => {
      addedInstances.push({ ...params });
    },
    removeInstance: (params) => {
      removedInstances.push({ ...params });
    },
  };

  return { arena, rankings, addedInstances, removedInstances, startMock, stopMock };
}

function makeConfig(overrides: Partial<EvolverConfig> = {}): EvolverConfig {
  const scorer: EvolverScorer = (r) => r.metrics.sharpeRatio;
  return {
    paramBounds: {
      fast: { min: 2, max: 50, step: 1 },
      slow: { min: 10, max: 200, step: 1 },
    },
    populationSize: 4,
    survivalRate: 0.5,
    mutationRate: 0.1,
    eliteCount: 1,
    evaluationWindowMs: 100,
    stagnationGenerations: 3,
    stagnationMutationRate: 0.3,
    scorer,
    ...overrides,
  };
}

describe('Evolver', () => {
  test('initializes with generation 0', () => {
    const { arena } = createMockArena();
    const evolver = new Evolver(arena, makeConfig());
    expect(evolver.generation).toBe(0);
  });

  test('start calls arena.start and adds instances', async () => {
    const { arena, addedInstances, startMock } = createMockArena();
    const config = makeConfig({ populationSize: 3, evaluationWindowMs: 100_000 });
    const evolver = new Evolver(arena, config);

    await evolver.start([{ fast: 10, slow: 50 }]);
    // Should have added populationSize instances
    expect(addedInstances.length).toBe(3);
    expect(startMock).toHaveBeenCalledTimes(1);

    await evolver.stop();
  });

  test('throws if initialParams is empty', async () => {
    const { arena } = createMockArena();
    const evolver = new Evolver(arena, makeConfig());

    let threw = false;
    try {
      await evolver.start([]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('stop calls arena.stop', async () => {
    const { arena, stopMock } = createMockArena();
    const config = makeConfig({ evaluationWindowMs: 100_000 });
    const evolver = new Evolver(arena, config);

    await evolver.start([{ fast: 10, slow: 50 }]);
    await evolver.stop();

    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  test('onGenerationComplete callback fires after evolve', async () => {
    const { arena, rankings } = createMockArena();
    const config = makeConfig({ evaluationWindowMs: 50 });
    const evolver = new Evolver(arena, config);

    // Set up rankings that the arena will return
    rankings.push(
      makeRanking({ fast: 10, slow: 50 }, { sharpeRatio: 2.0 }),
      makeRanking({ fast: 15, slow: 60 }, { sharpeRatio: 1.5 }),
      makeRanking({ fast: 8, slow: 40 }, { sharpeRatio: 1.0 }),
      makeRanking({ fast: 12, slow: 55 }, { sharpeRatio: 0.5 }),
    );

    const generationResults: ArenaRanking[][] = [];
    evolver.onGenerationComplete((r) => {
      generationResults.push(r);
    });

    await evolver.start([
      { fast: 10, slow: 50 },
      { fast: 15, slow: 60 },
      { fast: 8, slow: 40 },
      { fast: 12, slow: 55 },
    ]);

    // Wait for at least one generation to complete
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    await evolver.stop();

    expect(generationResults.length).toBeGreaterThanOrEqual(1);
    expect(evolver.generation).toBeGreaterThanOrEqual(1);
  });

  test('best params and metrics update after evolution', async () => {
    const { arena, rankings } = createMockArena();
    const config = makeConfig({ evaluationWindowMs: 50 });
    const evolver = new Evolver(arena, config);

    rankings.push(
      makeRanking({ fast: 10, slow: 50 }, { sharpeRatio: 2.5 }),
      makeRanking({ fast: 15, slow: 60 }, { sharpeRatio: 1.0 }),
      makeRanking({ fast: 8, slow: 40 }, { sharpeRatio: 0.5 }),
      makeRanking({ fast: 12, slow: 55 }, { sharpeRatio: 0.2 }),
    );

    await evolver.start([
      { fast: 10, slow: 50 },
      { fast: 15, slow: 60 },
      { fast: 8, slow: 40 },
      { fast: 12, slow: 55 },
    ]);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    await evolver.stop();

    // Best params should be the one with highest sharpeRatio
    expect(evolver.bestParams['fast']).toBe(10);
    expect(evolver.bestParams['slow']).toBe(50);
    expect(evolver.bestMetrics.sharpeRatio).toBe(2.5);
  });

  test('casualties are removed from arena', async () => {
    const { arena, rankings, removedInstances } = createMockArena();
    const config = makeConfig({
      evaluationWindowMs: 50,
      populationSize: 4,
      survivalRate: 0.5,
      eliteCount: 1,
    });
    const evolver = new Evolver(arena, config);

    rankings.push(
      makeRanking({ fast: 10, slow: 50 }, { sharpeRatio: 2.0 }),
      makeRanking({ fast: 15, slow: 60 }, { sharpeRatio: 1.5 }),
      makeRanking({ fast: 8, slow: 40 }, { sharpeRatio: 1.0 }),
      makeRanking({ fast: 12, slow: 55 }, { sharpeRatio: 0.5 }),
    );

    await evolver.start([
      { fast: 10, slow: 50 },
      { fast: 15, slow: 60 },
      { fast: 8, slow: 40 },
      { fast: 12, slow: 55 },
    ]);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    await evolver.stop();

    // Bottom 50% should have been removed (fast=8/slow=40 and fast=12/slow=55)
    // Plus elite is removed and re-added for stats reset
    // Plus surviving non-elite is removed and re-added as mutated
    expect(removedInstances.length).toBeGreaterThanOrEqual(2);
  });

  test('double start is idempotent', async () => {
    const { arena, startMock } = createMockArena();
    const config = makeConfig({ evaluationWindowMs: 100_000 });
    const evolver = new Evolver(arena, config);

    await evolver.start([{ fast: 10, slow: 50 }]);
    await evolver.start([{ fast: 20, slow: 60 }]);

    expect(startMock).toHaveBeenCalledTimes(1);

    await evolver.stop();
  });

  test('double stop is idempotent', async () => {
    const { arena, stopMock } = createMockArena();
    const config = makeConfig({ evaluationWindowMs: 100_000 });
    const evolver = new Evolver(arena, config);

    await evolver.start([{ fast: 10, slow: 50 }]);
    await evolver.stop();
    await evolver.stop();

    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  test('population fills to populationSize from fewer initial params', async () => {
    const { arena, addedInstances } = createMockArena();
    const config = makeConfig({ populationSize: 6, evaluationWindowMs: 100_000 });
    const evolver = new Evolver(arena, config);

    // Only provide 2 initial params, but populationSize is 6
    await evolver.start([
      { fast: 10, slow: 50 },
      { fast: 20, slow: 100 },
    ]);

    expect(addedInstances.length).toBe(6);

    await evolver.stop();
  });

  test('multiple callbacks all receive rankings', async () => {
    const { arena, rankings } = createMockArena();
    const config = makeConfig({ evaluationWindowMs: 50, populationSize: 2 });
    const evolver = new Evolver(arena, config);

    rankings.push(
      makeRanking({ fast: 10, slow: 50 }, { sharpeRatio: 2.0 }),
      makeRanking({ fast: 15, slow: 60 }, { sharpeRatio: 1.0 }),
    );

    let cb1Count = 0;
    let cb2Count = 0;
    evolver.onGenerationComplete(() => {
      cb1Count++;
    });
    evolver.onGenerationComplete(() => {
      cb2Count++;
    });

    await evolver.start([
      { fast: 10, slow: 50 },
      { fast: 15, slow: 60 },
    ]);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    await evolver.stop();

    expect(cb1Count).toBeGreaterThanOrEqual(1);
    expect(cb2Count).toBeGreaterThanOrEqual(1);
    expect(cb1Count).toBe(cb2Count);
  });
});
