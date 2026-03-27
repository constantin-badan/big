import type { Candle } from '@trading-bot/types';

export interface IIndicator<TConfig = unknown, TOutput = number> {
  readonly name: string;
  readonly warmupPeriod: number;
  readonly config: TConfig;
  update(candle: Candle): TOutput | null;
  reset(): void;
}

// A zero-arg factory that creates a fresh, independent indicator instance.
// Config is pre-bound in the closure at the strategy factory level:
//   indicators: { ema: () => createEMA({ period: params.emaPeriod }) }
// Scanners call factory() with no args — they don't know or care about configs.
export type IndicatorFactory = () => IIndicator;
