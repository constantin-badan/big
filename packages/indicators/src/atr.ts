import type { Candle } from '@trading-bot/types';
import type { IIndicator, IndicatorFactory } from './types';

export interface ATRConfig {
  period: number;
}

export class ATR implements IIndicator<ATRConfig, number> {
  readonly name = 'ATR';
  readonly warmupPeriod: number;
  readonly config: ATRConfig;

  private trWindow: number[] = [];
  private prevClose: number | null = null;
  private value: number | null = null;

  constructor(config: ATRConfig) {
    if (config.period <= 0 || !Number.isInteger(config.period)) {
      throw new Error(`ATR: period must be a positive integer, got ${config.period}`);
    }
    this.config = config;
    this.warmupPeriod = config.period;
  }

  update(candle: Candle): number | null {
    const tr = this.trueRange(candle);
    this.prevClose = candle.close;

    if (this.value === null) {
      // Still seeding: collect period TRs and return SMA
      this.trWindow.push(tr);
      if (this.trWindow.length < this.config.period) {
        return null;
      }
      // First ATR = SMA of first `period` TRs
      let sum = 0;
      for (const v of this.trWindow) {
        sum += v;
      }
      this.value = sum / this.config.period;
      this.trWindow = [];
      return this.value;
    }

    // Wilder's smoothing for subsequent values
    this.value = (this.value * (this.config.period - 1) + tr) / this.config.period;
    return this.value;
  }

  private trueRange(candle: Candle): number {
    if (this.prevClose === null) {
      return candle.high - candle.low;
    }
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - this.prevClose),
      Math.abs(candle.low - this.prevClose),
    );
  }

  reset(): void {
    this.trWindow = [];
    this.prevClose = null;
    this.value = null;
  }
}

export const createATR: IndicatorFactory<ATRConfig> = (config) => new ATR(config);
