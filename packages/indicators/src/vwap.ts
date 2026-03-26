import type { Candle } from '@trading-bot/types';
import type { IIndicator, IndicatorFactory } from './types';

export interface VWAPConfig {
  resetOffsetMs?: number;
}

export class VWAP implements IIndicator<VWAPConfig, number> {
  readonly name = 'VWAP';
  readonly warmupPeriod = 1;
  readonly config: VWAPConfig;

  private cumTPV = 0; // cumulative (typicalPrice * volume)
  private cumVolume = 0;
  private prevDayIndex: number | null = null;

  constructor(config: VWAPConfig) {
    this.config = config;
  }

  update(candle: Candle): number | null {
    const offset = this.config.resetOffsetMs ?? 0;
    const dayIndex = Math.floor((candle.openTime - offset) / 86_400_000);

    // Reset on new session
    if (this.prevDayIndex !== null && dayIndex !== this.prevDayIndex) {
      this.cumTPV = 0;
      this.cumVolume = 0;
    }
    this.prevDayIndex = dayIndex;

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    this.cumTPV += typicalPrice * candle.volume;
    this.cumVolume += candle.volume;

    return this.cumTPV / this.cumVolume;
  }

  reset(): void {
    this.cumTPV = 0;
    this.cumVolume = 0;
    this.prevDayIndex = null;
  }
}

export const createVWAP: IndicatorFactory<VWAPConfig> = (config) => new VWAP(config);
