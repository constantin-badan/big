import type { Candle, IIndicator } from '@trading-bot/types';

import { ATR } from './atr';
import { EMA } from './ema';

export interface KeltnerConfig {
  emaPeriod: number;
  atrPeriod: number;
  atrMultiplier: number;
}

export class Keltner implements IIndicator<KeltnerConfig, number> {
  readonly name = 'Keltner';
  readonly warmupPeriod: number;
  readonly config: KeltnerConfig;

  private ema: EMA;
  private atr: ATR;

  constructor(config: KeltnerConfig) {
    if (config.emaPeriod <= 0 || !Number.isInteger(config.emaPeriod)) {
      throw new Error(
        `Keltner: emaPeriod must be a positive integer, got ${config.emaPeriod}`,
      );
    }
    if (config.atrPeriod <= 0 || !Number.isInteger(config.atrPeriod)) {
      throw new Error(
        `Keltner: atrPeriod must be a positive integer, got ${config.atrPeriod}`,
      );
    }
    if (config.atrMultiplier <= 0) {
      throw new Error(
        `Keltner: atrMultiplier must be positive, got ${config.atrMultiplier}`,
      );
    }
    this.config = config;
    this.ema = new EMA({ period: config.emaPeriod });
    this.atr = new ATR({ period: config.atrPeriod });
    this.warmupPeriod = Math.max(config.emaPeriod, config.atrPeriod);
  }

  update(candle: Candle): number | null {
    const emaValue = this.ema.update(candle);
    const atrValue = this.atr.update(candle);

    if (emaValue === null || atrValue === null) return null;

    const upper = emaValue + atrValue * this.config.atrMultiplier;
    const lower = emaValue - atrValue * this.config.atrMultiplier;
    const bandwidth = upper - lower;

    if (bandwidth === 0) return 0.5;

    return (candle.close - lower) / bandwidth;
  }

  reset(): void {
    this.ema.reset();
    this.atr.reset();
  }
}

export const createKeltner = (
  config: KeltnerConfig,
): IIndicator<KeltnerConfig, number> => new Keltner(config);
