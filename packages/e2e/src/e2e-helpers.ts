/**
 * Shared helpers for E2E tests. Extracted to avoid duplication across test files.
 * Contains: golden candle generator, parameterized EMA crossover factory.
 */
import { createEMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  Candle,
  PositionManagerConfig,
  RiskConfig,
  ScannerEvaluate,
  StrategyFactory,
  Symbol,
  Timeframe,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

// ─── Constants ──────────────────────────────────────────────────────

export const BTCUSDT = toSymbol('BTCUSDT');
export const BASE_TIME = 1_700_000_000_000;
export const CANDLE_MS = 60_000;

// ─── Golden Candle Generator ────────────────────────────────────────

/**
 * Builds 50 candles with a predictable price pattern:
 *   0-19 : UP    from 100 to 195  (close = 100 + i * 5)
 *   20-34: DOWN  from 200 to 130  (close = 200 - (i-20) * 5)
 *   35-49: UP    from 130 to 200  (close = 130 + (i-35) * 5)
 *
 * High = close + 2, Low = close - 2 (fixed bracket, no randomness).
 */
export function makeGoldenCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    let close: number;
    if (i <= 19) {
      close = 100 + i * 5;
    } else if (i <= 34) {
      close = 200 - (i - 20) * 5;
    } else {
      close = 130 + (i - 35) * 5;
    }
    const open = close - 1;
    const high = close + 2;
    const low = close - 2;
    candles.push({
      symbol: BTCUSDT,
      openTime: BASE_TIME + i * CANDLE_MS,
      closeTime: BASE_TIME + (i + 1) * CANDLE_MS - 1,
      open,
      high,
      low,
      close,
      volume: 1000,
      quoteVolume: 1000 * close,
      trades: 100,
      isClosed: true,
    });
  }
  return candles;
}

// ─── EMA Crossover Factory ─────────────────────────────────────────

/**
 * Parameterized EMA crossover strategy factory.
 * Reads params.fastPeriod and params.slowPeriod (defaults 5, 10).
 * Detects bullish (fast crosses above slow) and bearish crossovers.
 * Single scanner watches the provided symbols list.
 */
export function makeEmaCrossoverFactory(
  symbols: Symbol[],
  riskCfg: RiskConfig,
  pmCfg: PositionManagerConfig,
  timeframe: Timeframe = '1m',
): StrategyFactory {
  return (params, deps) => {
    const fastPeriod = params.fastPeriod ?? 5;
    const slowPeriod = params.slowPeriod ?? 10;

    const prevFastMap = new Map<string, number>();
    const prevSlowMap = new Map<string, number>();

    const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
      const fast = indicators.fast;
      const slow = indicators.slow;
      if (fast === undefined || slow === undefined) return null;

      const prevFast = prevFastMap.get(symbol) ?? null;
      const prevSlow = prevSlowMap.get(symbol) ?? null;

      prevFastMap.set(symbol, fast);
      prevSlowMap.set(symbol, slow);

      if (prevFast === null || prevSlow === null) return null;

      if (prevFast <= prevSlow && fast > slow) {
        return {
          action: 'ENTER_LONG',
          confidence: 0.9,
          price: candle.close,
          metadata: { fast, slow, crossover: 'bullish' },
        };
      }

      if (prevFast >= prevSlow && fast < slow) {
        return {
          action: 'ENTER_SHORT',
          confidence: 0.9,
          price: candle.close,
          metadata: { fast, slow, crossover: 'bearish' },
        };
      }

      return null;
    };

    const scannerFactory = createScannerFactory('ema-cross', evaluate);
    const scanner = scannerFactory(deps.bus, {
      symbols,
      timeframe,
      indicators: {
        fast: () => createEMA({ period: fastPeriod }),
        slow: () => createEMA({ period: slowPeriod }),
      },
    });

    const riskManager = new RiskManager(deps.bus, riskCfg);
    const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, null, pmCfg);

    return new Strategy(
      {
        name: 'ema-crossover',
        symbols,
        scanners: [scanner],
        signalMerge: passthroughMerge,
        signalBufferWindowMs: CANDLE_MS,
        positionManager,
        riskManager,
      },
      deps,
    );
  };
}
