import type { Candle, IIndicator } from '@trading-bot/types';

export interface BollingerConfig {
  period: number;
  stdDevMultiplier: number;
}

/**
 * Bollinger Bands indicator returning %B.
 *
 * %B = (close - lowerBand) / (upperBand - lowerBand)
 *
 * Typically 0-1: below 0 = below lower band, above 1 = above upper band.
 * Returns 0.5 if bands have zero width (all prices identical).
 */
export class Bollinger implements IIndicator<BollingerConfig, number> {
  readonly name = 'Bollinger';
  readonly warmupPeriod: number;
  readonly config: BollingerConfig;

  private window: number[] = [];

  constructor(config: BollingerConfig) {
    if (config.period <= 0 || !Number.isInteger(config.period)) {
      throw new Error(`Bollinger: period must be a positive integer, got ${config.period}`);
    }
    if (config.stdDevMultiplier <= 0) {
      throw new Error(
        `Bollinger: stdDevMultiplier must be positive, got ${config.stdDevMultiplier}`,
      );
    }
    this.config = config;
    this.warmupPeriod = config.period;
  }

  update(candle: Candle): number | null {
    this.window.push(candle.close);

    if (this.window.length < this.config.period) return null;

    // Keep only the most recent `period` values
    if (this.window.length > this.config.period) {
      this.window.shift();
    }

    // SMA
    let sum = 0;
    for (const v of this.window) sum += v;
    const sma = sum / this.config.period;

    // Standard deviation (population)
    let sqSum = 0;
    for (const v of this.window) {
      const diff = v - sma;
      sqSum += diff * diff;
    }
    const stdDev = Math.sqrt(sqSum / this.config.period);

    const upper = sma + this.config.stdDevMultiplier * stdDev;
    const lower = sma - this.config.stdDevMultiplier * stdDev;
    const bandwidth = upper - lower;

    if (bandwidth === 0) return 0.5;

    return (candle.close - lower) / bandwidth;
  }

  reset(): void {
    this.window = [];
  }
}

export const createBollinger = (
  config: BollingerConfig,
): IIndicator<BollingerConfig, number> => new Bollinger(config);
