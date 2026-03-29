import type { Candle, IIndicator } from '@trading-bot/types';

export interface EMAConfig {
  period: number;
}

export class EMA implements IIndicator<EMAConfig, number> {
  readonly name = 'EMA';
  readonly warmupPeriod: number;
  readonly config: EMAConfig;

  private seedWindow: number[] = [];
  private value: number | null = null;
  private readonly multiplier: number;

  constructor(config: EMAConfig) {
    if (config.period <= 0 || !Number.isInteger(config.period)) {
      throw new Error(`EMA: period must be a positive integer, got ${config.period}`);
    }
    this.config = config;
    this.warmupPeriod = config.period;
    this.multiplier = 2 / (config.period + 1);
  }

  update(candle: Candle): number | null {
    if (this.value === null) {
      // Still accumulating seed candles
      this.seedWindow.push(candle.close);
      if (this.seedWindow.length < this.config.period) {
        return null;
      }
      // Seed EMA with SMA of first `period` candles
      let sum = 0;
      for (const v of this.seedWindow) {
        sum += v;
      }
      this.value = sum / this.config.period;
      this.seedWindow = [];
      return this.value;
    }
    // Apply EMA multiplier
    this.value = this.value + this.multiplier * (candle.close - this.value);
    return this.value;
  }

  reset(): void {
    this.seedWindow = [];
    this.value = null;
  }
}

export const createEMA = (config: EMAConfig): IIndicator<EMAConfig, number> => new EMA(config);
