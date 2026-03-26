import type { Candle } from '@trading-bot/types';

export interface IIndicator<TConfig = unknown, TOutput = number> {
  readonly name: string;
  readonly warmupPeriod: number;
  readonly config: TConfig;
  update(candle: Candle): TOutput | null;
  reset(): void;
}

export type IndicatorFactory<TConfig = unknown, TOutput = number> = (
  config: TConfig,
) => IIndicator<TConfig, TOutput>;
