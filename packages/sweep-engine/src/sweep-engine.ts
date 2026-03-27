import type { IBacktestEngine } from '@trading-bot/backtest-engine';
import type { StrategyFactory, SweepParamGrid } from '@trading-bot/strategy';
import type { BacktestConfig, BacktestResult } from '@trading-bot/types';

import type { ISweepEngine, SweepConfig, SweepResult, SweepScorer } from './types';

const DEFAULT_MAX_COMBINATIONS = 10_000;

const defaultScorer: SweepScorer = (r: BacktestResult) => r.metrics.profitFactor;

function cartesianProduct(grid: SweepParamGrid): Record<string, number>[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [];

  let combos: Record<string, number>[] = [{}];

  for (const key of keys) {
    const values = grid[key];
    if (values === undefined || values.length === 0) return [];
    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [key]: value });
      }
    }
    combos = next;
  }

  return combos;
}

export function createSweepEngine(engine: IBacktestEngine): ISweepEngine {
  return {
    async run(
      factory: StrategyFactory,
      grid: SweepParamGrid,
      config: BacktestConfig,
      sweepConfig?: SweepConfig,
    ): Promise<SweepResult[]> {
      const paramSets = cartesianProduct(grid);
      const maxCombos = sweepConfig?.maxCombinations ?? DEFAULT_MAX_COMBINATIONS;
      if (paramSets.length > maxCombos) {
        throw new Error(
          `Sweep grid produces ${paramSets.length} combinations, exceeds limit of ${maxCombos}. ` +
            `Set sweepConfig.maxCombinations to override.`,
        );
      }

      const scorer = sweepConfig?.scorer ?? defaultScorer;
      const results: SweepResult[] = [];

      for (const params of paramSets) {
        const result = await engine.run(factory, params, config);
        results.push({ params, result });
      }

      // Sort by scorer descending (higher = better)
      results.sort((a, b) => {
        const scoreA = scorer(a.result);
        const scoreB = scorer(b.result);
        // Handle Infinity: both Infinity → 0, one Infinity → it wins
        if (scoreA === scoreB) return 0;
        if (scoreA === Infinity) return -1;
        if (scoreB === Infinity) return 1;
        return scoreB - scoreA;
      });

      return results;
    },
  };
}
