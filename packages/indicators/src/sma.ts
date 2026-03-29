import type { Candle, IIndicator } from '@trading-bot/types';

export interface SMAConfig {
  period: number;
}

export class SMA implements IIndicator<SMAConfig, number> {
  readonly name = 'SMA';
  readonly warmupPeriod: number;
  readonly config: SMAConfig;

  private window: number[] = [];

  constructor(config: SMAConfig) {
    if (config.period <= 0 || !Number.isInteger(config.period)) {
      throw new Error(`SMA: period must be a positive integer, got ${config.period}`);
    }
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
    for (const v of this.window) { sum += v; }
    return sum / this.config.period;
  }

  reset(): void {
    this.window = [];
  }
}

export const createSMA = (config: SMAConfig): IIndicator<SMAConfig, number> => new SMA(config);
