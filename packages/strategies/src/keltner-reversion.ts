/**
 * Keltner Channel Reversion Scanner Template
 *
 * Mean reversion when price touches/exceeds Keltner Channel bands.
 * ENTER_LONG when keltner < 0 (price below lower band) — mean reversion buy.
 * ENTER_SHORT when keltner > 1 (price above upper band) — mean reversion sell.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   emaPeriod: 10–30 (step 1)
 *   atrPeriod: 5–20 (step 1)
 *   atrMultiplier: 1.5–3.0 (step 0.1)
 */
import { createKeltner } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const keltnerReversion: ScannerTemplate = {
  name: 'keltner-reversion',
  description: 'Keltner Channel mean reversion. Enters when price reaches outer bands, expecting snap-back to EMA center.',

  params: {
    emaPeriod: { min: 10, max: 30, step: 1 },
    atrPeriod: { min: 5, max: 20, step: 1 },
    atrMultiplier: { min: 1.5, max: 3.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const emaPeriod = params.emaPeriod ?? 20;
      const atrPeriod = params.atrPeriod ?? 10;
      const atrMultiplier = params.atrMultiplier ?? 2.0;

      const prevKeltnerMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const keltner = indicators.keltner;
        if (keltner === undefined) return null;

        const prevKeltner = prevKeltnerMap.get(symbol) ?? null;
        prevKeltnerMap.set(symbol, keltner);

        if (prevKeltner === null) return null;

        // LONG: price below lower band (keltner < 0) — mean reversion buy
        if (keltner < 0) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, Math.abs(keltner - 0.5) * 2),
            price: candle.close,
            metadata: { keltner, prevKeltner, trigger: 'keltner-long' },
          };
        }

        // SHORT: price above upper band (keltner > 1) — mean reversion sell
        if (keltner > 1) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, Math.abs(keltner - 0.5) * 2),
            price: candle.close,
            metadata: { keltner, prevKeltner, trigger: 'keltner-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('keltner-reversion', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          keltner: () => createKeltner({ emaPeriod, atrPeriod, atrMultiplier }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `keltner-rev-${String(emaPeriod)}-${String(atrPeriod)}-${String(atrMultiplier)}`,
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
