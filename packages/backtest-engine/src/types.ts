import type { BacktestConfig, BacktestResult } from '@trading-bot/types';
import type { IStrategy } from '@trading-bot/strategy';

export interface IBacktestEngine {
  run(config: BacktestConfig, strategy: IStrategy): Promise<BacktestResult>;
}
