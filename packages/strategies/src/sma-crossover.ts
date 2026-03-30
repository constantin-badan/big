/**
 * SMA Crossover Scanner Template
 *
 * Detects bullish/bearish crossovers between fast and slow SMAs.
 * Same crossover logic as EMA crossover but with SMA — slower, different signal timing.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   fastPeriod: 3–50 (step 1)
 *   slowPeriod: 10–100 (step 1)
 */
import { createSMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const smaCrossover: ScannerTemplate = {
  name: 'sma-crossover',
  description: 'Enters on SMA fast/slow crossover. Bullish cross = LONG, bearish = SHORT.',

  params: {
    fastPeriod: { min: 3, max: 50, step: 1 },
    slowPeriod: { min: 10, max: 100, step: 1 },
  },

  isValid: (params) => (params.fastPeriod ?? 5) < (params.slowPeriod ?? 20),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const fastPeriod = params.fastPeriod ?? 5;
      const slowPeriod = params.slowPeriod ?? 20;

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

        // LONG: fast SMA crosses above slow SMA
        if (prevFast <= prevSlow && fast > slow) {
          return {
            action: 'ENTER_LONG',
            confidence: 0.9,
            price: candle.close,
            metadata: { fast, slow, crossover: 'bullish' },
          };
        }

        // SHORT: fast SMA crosses below slow SMA
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

      const scannerFactory = createScannerFactory('sma-cross', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          fast: () => createSMA({ period: fastPeriod }),
          slow: () => createSMA({ period: slowPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, pmConfig);

      return new Strategy(
        {
          name: `sma-cross-${String(fastPeriod)}-${String(slowPeriod)}`,
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
