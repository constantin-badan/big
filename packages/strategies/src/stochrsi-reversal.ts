/**
 * Stochastic RSI Reversal Scanner Template
 *
 * More sensitive version of RSI reversal using Stochastic RSI.
 * ENTER_LONG when StochRSI crosses up out of oversold zone.
 * ENTER_SHORT when StochRSI crosses down out of overbought zone.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   rsiPeriod: 7–21 (step 1)
 *   stochPeriod: 7–21 (step 1)
 *   oversold: 10–30 (step 5)
 *   overbought: 70–90 (step 5)
 */
import { createStochRSI } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const stochrsiReversal: ScannerTemplate = {
  name: 'stochrsi-reversal',
  description: 'Stochastic RSI crossover reversal. More sensitive than plain RSI, catches reversals earlier.',

  params: {
    rsiPeriod: { min: 7, max: 21, step: 1 },
    stochPeriod: { min: 7, max: 21, step: 1 },
    oversold: { min: 10, max: 30, step: 5 },
    overbought: { min: 70, max: 90, step: 5 },
  },

  isValid: (params) => (params.oversold ?? 20) < (params.overbought ?? 80),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const rsiPeriod = params.rsiPeriod ?? 14;
      const stochPeriod = params.stochPeriod ?? 14;
      const oversold = params.oversold ?? 20;
      const overbought = params.overbought ?? 80;

      const prevStochRsiMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const stochRsi = indicators.stochRsi;
        if (stochRsi === undefined) return null;

        const prevStochRsi = prevStochRsiMap.get(symbol) ?? null;
        prevStochRsiMap.set(symbol, stochRsi);

        if (prevStochRsi === null) return null;

        // LONG: StochRSI was below oversold, now crosses above
        if (prevStochRsi <= oversold && stochRsi > oversold) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, Math.abs(stochRsi - 50) / 50),
            price: candle.close,
            metadata: { stochRsi, prevStochRsi, trigger: 'stochrsi-oversold-reversal' },
          };
        }

        // SHORT: StochRSI was above overbought, now crosses below
        if (prevStochRsi >= overbought && stochRsi < overbought) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, Math.abs(stochRsi - 50) / 50),
            price: candle.close,
            metadata: { stochRsi, prevStochRsi, trigger: 'stochrsi-overbought-reversal' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('stochrsi-reversal', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          stochRsi: () => createStochRSI({ rsiPeriod, stochPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `stochrsi-rev-${String(rsiPeriod)}-${String(stochPeriod)}-${String(oversold)}-${String(overbought)}`,
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
