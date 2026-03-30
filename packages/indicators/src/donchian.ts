import type { Candle, IIndicator } from '@trading-bot/types';

export interface DonchianConfig {
  period: number;
}

export class Donchian implements IIndicator<DonchianConfig, number> {
  readonly name = 'Donchian';
  readonly warmupPeriod: number;
  readonly config: DonchianConfig;

  private highs: number[] = [];
  private lows: number[] = [];

  constructor(config: DonchianConfig) {
    if (config.period <= 0 || !Number.isInteger(config.period)) {
      throw new Error(`Donchian: period must be a positive integer, got ${config.period}`);
    }
    this.config = config;
    this.warmupPeriod = config.period;
  }

  update(candle: Candle): number | null {
    this.highs.push(candle.high);
    this.lows.push(candle.low);

    if (this.highs.length < this.config.period) return null;

    // Keep only the most recent `period` values
    if (this.highs.length > this.config.period) {
      this.highs.shift();
      this.lows.shift();
    }

    let upper = this.highs[0]!;
    let lower = this.lows[0]!;
    for (let i = 1; i < this.highs.length; i++) {
      if (this.highs[i]! > upper) upper = this.highs[i]!;
      if (this.lows[i]! < lower) lower = this.lows[i]!;
    }

    const range = upper - lower;
    if (range === 0) return 0.5;

    return (candle.close - lower) / range;
  }

  reset(): void {
    this.highs = [];
    this.lows = [];
  }
}

export const createDonchian = (
  config: DonchianConfig,
): IIndicator<DonchianConfig, number> => new Donchian(config);
