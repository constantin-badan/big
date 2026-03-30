/**
 * RSI Reversal Scanner Template
 *
 * Enters LONG when RSI crosses above oversold threshold (reversal from oversold).
 * Enters SHORT when RSI crosses below overbought threshold (reversal from overbought).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   rsiPeriod: 5–30 (step 1)
 *   oversold: 15–35 (step 1) — enter LONG when RSI rises above this
 *   overbought: 65–85 (step 1) — enter SHORT when RSI drops below this
 */
import { createRSI } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const rsiReversal: ScannerTemplate = {
  name: 'rsi-reversal',
  description: 'Enters on RSI crossing out of overbought/oversold zones. Reversal strategy.',

  params: {
    rsiPeriod: { min: 5, max: 30, step: 1 },
    oversold: { min: 15, max: 35, step: 1 },
    overbought: { min: 65, max: 85, step: 1 },
  },

  isValid: (params) => (params.oversold ?? 30) < (params.overbought ?? 70),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const rsiPeriod = params.rsiPeriod ?? 14;
      const oversold = params.oversold ?? 30;
      const overbought = params.overbought ?? 70;

      const prevRsiMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const rsi = indicators.rsi;
        if (rsi === undefined) return null;

        const prevRsi = prevRsiMap.get(symbol) ?? null;
        prevRsiMap.set(symbol, rsi);

        if (prevRsi === null) return null;

        // LONG: RSI was below oversold, now crosses above
        if (prevRsi <= oversold && rsi > oversold) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, (oversold - prevRsi + 5) / 20),
            price: candle.close,
            metadata: { rsi, prevRsi, trigger: 'oversold-reversal' },
          };
        }

        // SHORT: RSI was above overbought, now crosses below
        if (prevRsi >= overbought && rsi < overbought) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, (prevRsi - overbought + 5) / 20),
            price: candle.close,
            metadata: { rsi, prevRsi, trigger: 'overbought-reversal' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('rsi-reversal', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          rsi: () => createRSI({ period: rsiPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, pmConfig);

      return new Strategy(
        {
          name: `rsi-rev-${String(rsiPeriod)}-${String(oversold)}-${String(overbought)}`,
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
