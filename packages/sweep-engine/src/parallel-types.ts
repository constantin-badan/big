import type { BacktestConfig, BacktestResult, ExchangeConfig, SweepParamGrid } from '@trading-bot/types';

import type { SweepResult } from './types';

export type SweepScorerName = 'profitFactor' | 'sharpe' | 'expectancy' | 'winRate';

export interface ParallelSweepConfig {
  factoryModulePath: string;
  factoryExportName?: string; // default: 'factory'
  backtestConfig: BacktestConfig;
  exchangeConfig: ExchangeConfig; // must be backtest-sim
  dbPath: string;
  maxConcurrency?: number; // default: navigator.hardwareConcurrency
  maxCombinations?: number; // default: 50_000
  scorer?: SweepScorerName;
}

export interface ParallelSweepResult {
  results: SweepResult[];
  errors: Array<{ params: Record<string, number>; error: string }>;
}

export interface IParallelSweepEngine {
  run(grid: SweepParamGrid): Promise<ParallelSweepResult>;
}

// Messages between main thread and workers
export interface WorkerRequest {
  type: 'run';
  params: Record<string, number>;
  factoryModulePath: string;
  factoryExportName: string;
  backtestConfig: BacktestConfig;
  exchangeConfig: ExchangeConfig;
  dbPath: string;
}

export interface WorkerResponse {
  type: 'result' | 'error';
  params: Record<string, number>;
  result?: BacktestResult;
  error?: string;
}

export const BUILT_IN_SCORERS: Record<SweepScorerName, (r: BacktestResult) => number> = {
  profitFactor: (r) => r.metrics.profitFactor,
  sharpe: (r) => r.metrics.sharpeRatio,
  expectancy: (r) => r.metrics.expectancy,
  winRate: (r) => r.metrics.winRate,
};
