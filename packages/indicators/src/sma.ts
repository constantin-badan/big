import type { Candle } from '@trading-bot/types';
import type { IIndicator, IndicatorFactory } from './types';

export interface SMAConfig {
  period: number;
}

export class SMA implements IIndicator<SMAConfig, number> {
  readonly name = 'SMA';
  readonly warmupPeriod: number;
  readonly config: SMAConfig;

  private window: number[] = [];

  constructor(config: SMAConfig) {
    this.config = config;
    this.warmupPeriod = config.period;
  }

  update(candle: Candle): number | null {
    this.window.push(candle.close);
    if (this.window.length > this.config.period) {
      this.window.shift();
    }
    if (this.window.length < this.config.period) {
      return null;
    }
    let sum = 0;
    for (const v of this.window) {
      sum += v;
    }
    return sum / this.config.period;
  }

  reset(): void {
    this.window = [];
  }
}

export const createSMA: IndicatorFactory<SMAConfig> = (config) => new SMA(config);
