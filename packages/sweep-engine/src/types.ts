import type { IBacktestEngine } from '@trading-bot/backtest-engine';
import type { StrategyFactory, SweepParamGrid } from '@trading-bot/strategy';
import type { BacktestConfig, BacktestResult } from '@trading-bot/types';

export interface SweepResult {
  params: Record<string, number>;
  result: BacktestResult;
}

// Scoring function for ranking sweep results. Higher score = better.
// Default: profit factor. Override for Sharpe, composite scores, etc.
export type SweepScorer = (result: BacktestResult) => number;

export interface SweepConfig {
  maxCombinations?: number; // default 10_000 — throws if grid exceeds this
  scorer?: SweepScorer; // default: profit factor
}

export interface ISweepEngine {
  // Computes cartesian product of grid, runs each combination through IBacktestEngine.run().
  // Sequential for Phase 2 — parallelise with Bun workers in Phase 3.
  run(
    factory: StrategyFactory,
    grid: SweepParamGrid,
    config: BacktestConfig,
    sweepConfig?: SweepConfig,
  ): Promise<SweepResult[]>;
}

// Constructed with a pre-configured engine (loader + exchangeConfig already set)
export type CreateSweepEngine = (engine: IBacktestEngine) => ISweepEngine;
