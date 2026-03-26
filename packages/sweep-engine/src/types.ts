import type { BacktestConfig, BacktestResult, ExchangeConfig } from '@trading-bot/types';
import type { StrategyFactory, SweepParamGrid } from '@trading-bot/strategy';

export interface SweepConfig {
  backtestConfig: BacktestConfig;
  exchangeConfig: ExchangeConfig;
}

export interface SweepResult {
  params: Record<string, number>;
  result: BacktestResult;
}

export interface ISweepEngine {
  run(
    factory: StrategyFactory,
    grid: SweepParamGrid,
    config: SweepConfig,
  ): Promise<SweepResult[]>;
}
