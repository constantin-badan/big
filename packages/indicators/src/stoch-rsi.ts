import type { Candle, IIndicator } from '@trading-bot/types';

import { RSI } from './rsi';

export interface StochRSIConfig {
  rsiPeriod: number;
  stochPeriod: number;
}

export class StochRSI implements IIndicator<StochRSIConfig, number> {
  readonly name = 'StochRSI';
  readonly warmupPeriod: number;
  readonly config: StochRSIConfig;

  private rsi: RSI;
  private rsiWindow: number[] = [];

  constructor(config: StochRSIConfig) {
    if (config.rsiPeriod <= 0 || !Number.isInteger(config.rsiPeriod)) {
      throw new Error(`StochRSI: rsiPeriod must be a positive integer, got ${config.rsiPeriod}`);
    }
    if (config.stochPeriod <= 0 || !Number.isInteger(config.stochPeriod)) {
      throw new Error(
        `StochRSI: stochPeriod must be a positive integer, got ${config.stochPeriod}`,
      );
    }
    this.config = config;
    this.rsi = new RSI({ period: config.rsiPeriod });
    // RSI needs rsiPeriod+1 candles to produce its first value; then stochPeriod-1
    // additional candles to fill the rolling window (the first RSI value is included).
    this.warmupPeriod = config.rsiPeriod + config.stochPeriod;
  }

  update(candle: Candle): number | null {
    const rsiValue = this.rsi.update(candle);
    if (rsiValue === null) return null;

    this.rsiWindow.push(rsiValue);

    if (this.rsiWindow.length < this.config.stochPeriod) return null;

    // Keep only the most recent stochPeriod values
    if (this.rsiWindow.length > this.config.stochPeriod) {
      this.rsiWindow.shift();
    }

    let min = this.rsiWindow[0]!;
    let max = this.rsiWindow[0]!;
    for (let i = 1; i < this.rsiWindow.length; i++) {
      const v = this.rsiWindow[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    const range = max - min;
    if (range === 0) return 50;

    return ((rsiValue - min) / range) * 100;
  }

  reset(): void {
    this.rsi.reset();
    this.rsiWindow = [];
  }
}

export const createStochRSI = (
  config: StochRSIConfig,
): IIndicator<StochRSIConfig, number> => new StochRSI(config);
