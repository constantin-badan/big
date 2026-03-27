import type { Candle } from '@trading-bot/types';

import type { IIndicator } from './types';

export interface SMAConfig {
  period: number;
}

export class SMA implements IIndicator<SMAConfig, number> {
  readonly name = 'SMA';
  readonly warmupPeriod: number;
  readonly config: SMAConfig;

  private window: number[] = [];
  private runningSum = 0;

  constructor(config: SMAConfig) {
    if (config.period <= 0 || !Number.isInteger(config.period)) {
      throw new Error(`SMA: period must be a positive integer, got ${config.period}`);
    }
    this.config = config;
    this.warmupPeriod = config.period;
  }

  update(candle: Candle): number | null {
    this.window.push(candle.close);
    this.runningSum += candle.close;
    if (this.window.length > this.config.period) {
      this.runningSum -= this.window.shift()!;
    }
    if (this.window.length < this.config.period) {
      return null;
    }
    return this.runningSum / this.config.period;
  }

  reset(): void {
    this.window = [];
    this.runningSum = 0;
  }
}

export const createSMA = (config: SMAConfig): IIndicator<SMAConfig, number> => new SMA(config);
