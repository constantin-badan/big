import type { Candle, IIndicator } from '@trading-bot/types';

export interface MACDConfig {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

/**
 * Lightweight EMA used internally by MACD.
 * Operates on raw numbers (not candles).
 */
class InternalEMA {
  private value: number | null = null;
  private seedWindow: number[] = [];
  private readonly period: number;
  private readonly multiplier: number;

  constructor(period: number) {
    this.period = period;
    this.multiplier = 2 / (period + 1);
  }

  update(value: number): number | null {
    if (this.value === null) {
      this.seedWindow.push(value);
      if (this.seedWindow.length < this.period) return null;
      let sum = 0;
      for (const v of this.seedWindow) sum += v;
      this.value = sum / this.period;
      this.seedWindow = [];
      return this.value;
    }
    this.value = this.value + this.multiplier * (value - this.value);
    return this.value;
  }

  reset(): void {
    this.seedWindow = [];
    this.value = null;
  }
}

/**
 * MACD indicator returning the histogram (MACD line - signal line).
 *
 * Positive histogram = bullish momentum, negative = bearish, zero-cross = signal.
 */
export class MACD implements IIndicator<MACDConfig, number> {
  readonly name = 'MACD';
  readonly warmupPeriod: number;
  readonly config: MACDConfig;

  private readonly fastEMA: InternalEMA;
  private readonly slowEMA: InternalEMA;
  private readonly signalEMA: InternalEMA;

  constructor(config: MACDConfig) {
    if (config.fastPeriod <= 0 || !Number.isInteger(config.fastPeriod)) {
      throw new Error(`MACD: fastPeriod must be a positive integer, got ${config.fastPeriod}`);
    }
    if (config.slowPeriod <= 0 || !Number.isInteger(config.slowPeriod)) {
      throw new Error(`MACD: slowPeriod must be a positive integer, got ${config.slowPeriod}`);
    }
    if (config.signalPeriod <= 0 || !Number.isInteger(config.signalPeriod)) {
      throw new Error(`MACD: signalPeriod must be a positive integer, got ${config.signalPeriod}`);
    }
    this.config = config;
    this.warmupPeriod = config.slowPeriod + config.signalPeriod;
    this.fastEMA = new InternalEMA(config.fastPeriod);
    this.slowEMA = new InternalEMA(config.slowPeriod);
    this.signalEMA = new InternalEMA(config.signalPeriod);
  }

  update(candle: Candle): number | null {
    const fastResult = this.fastEMA.update(candle.close);
    const slowResult = this.slowEMA.update(candle.close);

    if (fastResult === null || slowResult === null) return null;

    const macdLine = fastResult - slowResult;
    const signalResult = this.signalEMA.update(macdLine);

    if (signalResult === null) return null;

    return macdLine - signalResult;
  }

  reset(): void {
    this.fastEMA.reset();
    this.slowEMA.reset();
    this.signalEMA.reset();
  }
}

export const createMACD = (config: MACDConfig): IIndicator<MACDConfig, number> => new MACD(config);
