/**
 * MACD Momentum Scanner Template
 *
 * Classic MACD histogram zero-cross with momentum confirmation.
 * ENTER_LONG when histogram crosses above 0.
 * ENTER_SHORT when histogram crosses below 0.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   fastPeriod: 8–20 (step 1)
 *   slowPeriod: 20–40 (step 1)
 *   signalPeriod: 5–15 (step 1)
 */
import { createMACD } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const macdMomentum: ScannerTemplate = {
  name: 'macd-momentum',
  description: 'MACD histogram zero-cross entry. Bullish when histogram crosses above 0, bearish when below.',

  params: {
    fastPeriod: { min: 8, max: 20, step: 1 },
    slowPeriod: { min: 20, max: 40, step: 1 },
    signalPeriod: { min: 5, max: 15, step: 1 },
  },

  isValid: (params) => (params.fastPeriod ?? 12) < (params.slowPeriod ?? 26),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const fastPeriod = params.fastPeriod ?? 12;
      const slowPeriod = params.slowPeriod ?? 26;
      const signalPeriod = params.signalPeriod ?? 9;

      const prevHistogramMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const histogram = indicators.macd;
        if (histogram === undefined) return null;

        const prevHistogram = prevHistogramMap.get(symbol) ?? null;
        prevHistogramMap.set(symbol, histogram);

        if (prevHistogram === null) return null;

        // LONG: histogram crosses above 0
        if (prevHistogram <= 0 && histogram > 0) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, Math.abs(histogram) / 10),
            price: candle.close,
            metadata: { histogram, prevHistogram, trigger: 'macd-zero-cross-up' },
          };
        }

        // SHORT: histogram crosses below 0
        if (prevHistogram >= 0 && histogram < 0) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, Math.abs(histogram) / 10),
            price: candle.close,
            metadata: { histogram, prevHistogram, trigger: 'macd-zero-cross-down' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('macd-momentum', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          macd: () => createMACD({ fastPeriod, slowPeriod, signalPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `macd-mom-${String(fastPeriod)}-${String(slowPeriod)}-${String(signalPeriod)}`,
          symbols,
          scanners: [scanner],
          signalMerge: passthroughMerge,
          signalBufferWindowMs: 60_000,
          positionManager,
          riskManager,
        },
        deps,
      );
    };
  },
};
