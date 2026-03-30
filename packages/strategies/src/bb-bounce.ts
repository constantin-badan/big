/**
 * Bollinger Band Bounce Scanner Template
 *
 * Pure Bollinger Band mean reversion — enter when price touches/exceeds outer band,
 * expecting snap-back to SMA center.
 * ENTER_LONG when %B < 0 (price below lower band).
 * ENTER_SHORT when %B > 1 (price above upper band).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   bbPeriod: 10–30 (step 1)
 *   bbStdDev: 1.5–3.0 (step 0.1)
 */
import { createBollinger } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const bbBounce: ScannerTemplate = {
  name: 'bb-bounce',
  description: 'Bollinger Band bounce. Enters at outer bands expecting snap-back to SMA center.',

  params: {
    bbPeriod: { min: 10, max: 30, step: 1 },
    bbStdDev: { min: 1.5, max: 3.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const bbPeriod = params.bbPeriod ?? 20;
      const bbStdDev = params.bbStdDev ?? 2.0;

      const prevBBMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const bb = indicators.bb;
        if (bb === undefined) return null;

        const prevBB = prevBBMap.get(symbol) ?? null;
        prevBBMap.set(symbol, bb);

        if (prevBB === null) return null;

        // LONG: %B < 0 (price below lower band)
        if (bb < 0) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, Math.abs(bb - 0.5) * 2),
            price: candle.close,
            metadata: { bb, prevBB, trigger: 'bb-bounce-long' },
          };
        }

        // SHORT: %B > 1 (price above upper band)
        if (bb > 1) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, Math.abs(bb - 0.5) * 2),
            price: candle.close,
            metadata: { bb, prevBB, trigger: 'bb-bounce-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('bb-bounce', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          bb: () => createBollinger({ period: bbPeriod, stdDevMultiplier: bbStdDev }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `bb-bounce-${String(bbPeriod)}-${String(bbStdDev)}`,
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
