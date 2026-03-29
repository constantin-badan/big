import type { IndicatorFactory } from '@trading-bot/indicators';
import type { Candle, IEventBus, Signal, Symbol, Timeframe } from '@trading-bot/types';

export interface IScannerConfig {
  symbols: Symbol[];
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
  symbol: Symbol,
) => Omit<Signal, 'symbol' | 'sourceScanner' | 'timestamp'> | null;
