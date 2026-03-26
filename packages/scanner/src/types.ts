import type { Candle, Signal, Timeframe } from '@trading-bot/types';
import type { IEventBus } from '@trading-bot/event-bus';
import type { IndicatorFactory } from '@trading-bot/indicators';

export interface IScannerConfig {
  symbols: string[];
  timeframe: Timeframe;
  indicators: Record<string, IndicatorFactory>;
}

export interface IScanner {
  readonly name: string;
  readonly config: IScannerConfig;
  dispose(): void;
}

export type ScannerFactory = (eventBus: IEventBus, config: IScannerConfig) => IScanner;

// Called on each candle:close for the scanner's timeframe.
// indicators: live values for this symbol (already updated with the current candle, only non-null)
// candle: the closed candle
// Returns a Signal to emit, or null for no signal this candle.
export type ScannerEvaluate = (
  indicators: Record<string, number>,
  candle: Candle,
  symbol: string,
) => Omit<Signal, 'symbol' | 'sourceScanner' | 'timestamp'> | null;
