import type { BacktestConfig, BacktestResult } from '@trading-bot/types';
import type { StrategyFactory, SweepParamGrid } from '@trading-bot/strategy';
import type { IBacktestEngine } from '@trading-bot/backtest-engine';

export interface SweepResult {
  params: Record<string, number>;
  result: BacktestResult;
}

export interface ISweepEngine {
  // Computes cartesian product of grid, runs each combination through IBacktestEngine.run().
  // Sequential for Phase 2 — parallelise with Bun workers in Phase 3.
  run(
    factory: StrategyFactory,
    grid: SweepParamGrid,
    config: BacktestConfig,
  ): Promise<SweepResult[]>;
}

// Constructed with a pre-configured engine (loader + exchangeConfig already set)
export type CreateSweepEngine = (engine: IBacktestEngine) => ISweepEngine;
