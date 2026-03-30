/**
 * EMA Crossover Scanner Template
 *
 * Detects bullish/bearish crossovers between fast and slow EMAs.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   fastPeriod: 3–50 (step 1)
 *   slowPeriod: 5–100 (step 1)
 */
import { createEMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const emaCrossover: ScannerTemplate = {
  name: 'ema-crossover',
  description: 'Enters on EMA fast/slow crossover. Bullish cross = LONG, bearish = SHORT.',

  params: {
    fastPeriod: { min: 3, max: 50, step: 1 },
    slowPeriod: { min: 5, max: 100, step: 1 },
  },

  isValid: (params) => (params.fastPeriod ?? 5) < (params.slowPeriod ?? 10),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
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

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `ema-cross-${String(fastPeriod)}-${String(slowPeriod)}`,
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

// Backward compat: standalone factory for scripts/tests that don't use templates yet
export const createEmaCrossoverFactory = emaCrossover.createFactory;
