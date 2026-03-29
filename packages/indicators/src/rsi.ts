import type { Candle, IIndicator } from '@trading-bot/types';

export interface RSIConfig {
  period: number;
}

interface RSIState {
  avgGain: number;
  avgLoss: number;
  prevClose: number;
}

export class RSI implements IIndicator<RSIConfig, number> {
  readonly name = 'RSI';
  readonly warmupPeriod: number;
  readonly config: RSIConfig;

  private seedCloses: number[] = [];
  private state: RSIState | null = null;
  private readonly smoothFactor: number;

  constructor(config: RSIConfig) {
    if (config.period <= 0 || !Number.isInteger(config.period)) {
      throw new Error(`RSI: period must be a positive integer, got ${config.period}`);
    }
    this.config = config;
    // warmup = period + 1: need period+1 closes to compute period changes
    this.warmupPeriod = config.period + 1;
    this.smoothFactor = 1 / config.period;
  }

  update(candle: Candle): number | null {
    if (this.state === null) {
      // Still in seed phase: collect period+1 closes
      this.seedCloses.push(candle.close);
      if (this.seedCloses.length < this.config.period + 1) {
        return null;
      }
      // Seed avgGain and avgLoss from the first `period` changes
      let gainSum = 0;
      let lossSum = 0;
      for (let i = 1; i < this.seedCloses.length; i++) {
        const change = (this.seedCloses[i] ?? 0) - (this.seedCloses[i - 1] ?? 0);
        if (change > 0) {
          gainSum += change;
        } else {
          lossSum += Math.abs(change);
        }
      }
      this.state = {
        avgGain: gainSum / this.config.period,
        avgLoss: lossSum / this.config.period,
        prevClose: this.seedCloses[this.seedCloses.length - 1] ?? 0,
      };
      this.seedCloses = [];
      return this.computeRSI(this.state.avgGain, this.state.avgLoss);
    }

    // Apply Wilder's smoothing
    const change = candle.close - this.state.prevClose;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    this.state = {
      avgGain: this.state.avgGain * (1 - this.smoothFactor) + gain * this.smoothFactor,
      avgLoss: this.state.avgLoss * (1 - this.smoothFactor) + loss * this.smoothFactor,
      prevClose: candle.close,
    };
    return this.computeRSI(this.state.avgGain, this.state.avgLoss);
  }

  private computeRSI(avgGain: number, avgLoss: number): number {
    if (avgGain === 0 && avgLoss === 0) {
      return 50; // No price movement — neutral
    }
    if (avgLoss === 0) {
      return 100;
    }
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  reset(): void {
    this.seedCloses = [];
    this.state = null;
  }
}

export const createRSI = (config: RSIConfig): IIndicator<RSIConfig, number> => new RSI(config);
