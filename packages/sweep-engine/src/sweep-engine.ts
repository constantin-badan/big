import type { IBacktestEngine } from '@trading-bot/backtest-engine';
import type { BacktestConfig, BacktestResult, StrategyFactory, SweepParamGrid } from '@trading-bot/types';

import { cartesianProduct } from './cartesian';
import type { ISweepEngine, SweepConfig, SweepResult, SweepScorer } from './types';

const DEFAULT_MAX_COMBINATIONS = 10_000;

const defaultScorer: SweepScorer = (r: BacktestResult) => r.metrics.profitFactor;

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
