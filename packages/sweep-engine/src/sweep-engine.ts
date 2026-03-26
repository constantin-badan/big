import type { IBacktestEngine } from '@trading-bot/backtest-engine';
import type { StrategyFactory, SweepParamGrid } from '@trading-bot/strategy';
import type { BacktestConfig } from '@trading-bot/types';
import type { ISweepEngine, SweepResult } from './types';

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
    ): Promise<SweepResult[]> {
      const paramSets = cartesianProduct(grid);
      const results: SweepResult[] = [];

      for (const params of paramSets) {
        const result = await engine.run(factory, params, config);
        results.push({ params, result });
      }

      // Sort by profitFactor descending
      results.sort((a, b) => {
        const pfA = a.result.metrics.profitFactor;
        const pfB = b.result.metrics.profitFactor;
        // Handle Infinity: both Infinity → 0, one Infinity → it wins
        if (pfA === pfB) return 0;
        if (pfA === Infinity) return -1;
        if (pfB === Infinity) return 1;
        return pfB - pfA;
      });

      return results;
    },
  };
}
