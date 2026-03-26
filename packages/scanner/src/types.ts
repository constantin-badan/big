import type { Timeframe } from '@trading-bot/types';
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
