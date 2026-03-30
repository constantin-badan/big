/**
 * VWAP Reversion Scanner Template
 *
 * Mean reversion strategy around VWAP.
 * ENTER_LONG when price drops below VWAP by deviationPct (expect bounce back up).
 * ENTER_SHORT when price rises above VWAP by deviationPct (expect revert down).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   deviationPct: 0.5–3.0 (step 0.1)
 */
import { createVWAP } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const vwapReversion: ScannerTemplate = {
  name: 'vwap-reversion',
  description: 'Enters on mean reversion around VWAP. Price deviating from VWAP = reversion expected.',

  params: {
    deviationPct: { min: 0.5, max: 3.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const deviationPct = params.deviationPct ?? 1.5;

      const prevDeviationMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const vwap = indicators.vwap;
        if (vwap === undefined || vwap === 0) return null;

        const deviation = ((candle.close - vwap) / vwap) * 100;
        const prevDeviation = prevDeviationMap.get(symbol) ?? null;
        prevDeviationMap.set(symbol, deviation);

        if (prevDeviation === null) return null;

        // LONG: price crosses below VWAP - deviationPct (mean reversion — expect bounce back)
        if (prevDeviation >= -deviationPct && deviation < -deviationPct) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, Math.abs(deviation) / (deviationPct * 2)),
            price: candle.close,
            metadata: { vwap, deviation, prevDeviation, trigger: 'vwap-below-reversion' },
          };
        }

        // SHORT: price crosses above VWAP + deviationPct (expect revert down)
        if (prevDeviation <= deviationPct && deviation > deviationPct) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, Math.abs(deviation) / (deviationPct * 2)),
            price: candle.close,
            metadata: { vwap, deviation, prevDeviation, trigger: 'vwap-above-reversion' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('vwap-reversion', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          vwap: () => createVWAP({}),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, pmConfig);

      return new Strategy(
        {
          name: `vwap-rev-${String(deviationPct)}`,
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
