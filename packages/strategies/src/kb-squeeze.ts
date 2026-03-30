/**
 * Keltner-Bollinger Squeeze Scanner Template
 *
 * Classic squeeze play: when Bollinger Bands contract (price compresses near middle),
 * enter on expansion direction.
 * Tracks consecutive "squeeze bars" where %B stays between 0.3 and 0.7.
 * ENTER_LONG when squeezeBars >= 3 AND %B > 0.8 (breaking up out of squeeze).
 * ENTER_SHORT when squeezeBars >= 3 AND %B < 0.2 (breaking down out of squeeze).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   bbPeriod: 15–25 (step 1)
 *   bbStdDev: 1.5–2.5 (step 0.1)
 *   kcEmaPeriod: 15–25 (step 1)
 *   kcAtrPeriod: 8–15 (step 1)
 *   kcAtrMult: 1.0–2.0 (step 0.1)
 */
import { createBollinger, createKeltner } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const kbSqueeze: ScannerTemplate = {
  name: 'kb-squeeze',
  description: 'Keltner-Bollinger squeeze breakout. Detects low-volatility squeeze then enters on expansion direction.',

  params: {
    bbPeriod: { min: 15, max: 25, step: 1 },
    bbStdDev: { min: 1.5, max: 2.5, step: 0.1 },
    kcEmaPeriod: { min: 15, max: 25, step: 1 },
    kcAtrPeriod: { min: 8, max: 15, step: 1 },
    kcAtrMult: { min: 1.0, max: 2.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const bbPeriod = params.bbPeriod ?? 20;
      const bbStdDev = params.bbStdDev ?? 2.0;
      const kcEmaPeriod = params.kcEmaPeriod ?? 20;
      const kcAtrPeriod = params.kcAtrPeriod ?? 10;
      const kcAtrMult = params.kcAtrMult ?? 1.5;

      const squeezeBarsMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const bb = indicators.bb;
        const keltner = indicators.keltner;
        if (bb === undefined || keltner === undefined) return null;

        let squeezeBars = squeezeBarsMap.get(symbol) ?? 0;

        // Squeeze: %B compressed near middle (between 0.3 and 0.7)
        if (bb >= 0.3 && bb <= 0.7) {
          squeezeBars++;
          squeezeBarsMap.set(symbol, squeezeBars);
          return null;
        }

        // LONG: squeeze released upward
        if (squeezeBars >= 3 && bb > 0.8) {
          squeezeBarsMap.set(symbol, 0);
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, squeezeBars / 10 + (bb - 0.8) * 5),
            price: candle.close,
            metadata: { bb, keltner, squeezeBars, trigger: 'kb-squeeze-long' },
          };
        }

        // SHORT: squeeze released downward
        if (squeezeBars >= 3 && bb < 0.2) {
          squeezeBarsMap.set(symbol, 0);
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, squeezeBars / 10 + (0.2 - bb) * 5),
            price: candle.close,
            metadata: { bb, keltner, squeezeBars, trigger: 'kb-squeeze-short' },
          };
        }

        // Outside squeeze range but no signal — reset
        squeezeBarsMap.set(symbol, 0);
        return null;
      };

      const scannerFactory = createScannerFactory('kb-squeeze', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          bb: () => createBollinger({ period: bbPeriod, stdDevMultiplier: bbStdDev }),
          keltner: () => createKeltner({ emaPeriod: kcEmaPeriod, atrPeriod: kcAtrPeriod, atrMultiplier: kcAtrMult }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `kb-sq-${String(bbPeriod)}-${String(bbStdDev)}-${String(kcEmaPeriod)}`,
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
