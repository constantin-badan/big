/**
 * RSI + StochRSI Double Confirmation Scanner Template
 *
 * Both RSI and StochRSI must agree on oversold/overbought for stronger reversal signals.
 * ENTER_LONG when prevRsi <= oversold AND rsi > oversold AND stochRsi < 50 (confirming).
 * ENTER_SHORT when prevRsi >= overbought AND rsi < overbought AND stochRsi > 50 (confirming).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   rsiPeriod: 7–21 (step 1)
 *   stochPeriod: 7–21 (step 1)
 *   oversold: 15–35 (step 5)
 *   overbought: 65–85 (step 5)
 */
import { createRSI, createStochRSI } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const rsiStochrsi: ScannerTemplate = {
  name: 'rsi-stochrsi',
  description: 'RSI + StochRSI double confirmation. Both must be oversold/overbought for high-confidence reversal.',

  params: {
    rsiPeriod: { min: 7, max: 21, step: 1 },
    stochPeriod: { min: 7, max: 21, step: 1 },
    oversold: { min: 15, max: 35, step: 5 },
    overbought: { min: 65, max: 85, step: 5 },
  },

  isValid: (params) => (params.oversold ?? 25) < (params.overbought ?? 75),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const rsiPeriod = params.rsiPeriod ?? 14;
      const stochPeriod = params.stochPeriod ?? 14;
      const oversold = params.oversold ?? 25;
      const overbought = params.overbought ?? 75;

      const prevRsiMap = new Map<string, number>();
      const prevStochRsiMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const rsi = indicators.rsi;
        const stochRsi = indicators.stochRsi;
        if (rsi === undefined || stochRsi === undefined) return null;

        const prevRsi = prevRsiMap.get(symbol) ?? null;
        const prevStochRsi = prevStochRsiMap.get(symbol) ?? null;
        prevRsiMap.set(symbol, rsi);
        prevStochRsiMap.set(symbol, stochRsi);

        if (prevRsi === null || prevStochRsi === null) return null;

        // LONG: RSI crosses above oversold AND StochRSI confirms (still low)
        if (prevRsi <= oversold && rsi > oversold && stochRsi < 50) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, (oversold - prevRsi + 5) / 20 + (50 - stochRsi) / 100),
            price: candle.close,
            metadata: { rsi, prevRsi, stochRsi, trigger: 'rsi-stochrsi-long' },
          };
        }

        // SHORT: RSI crosses below overbought AND StochRSI confirms (still high)
        if (prevRsi >= overbought && rsi < overbought && stochRsi > 50) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, (prevRsi - overbought + 5) / 20 + (stochRsi - 50) / 100),
            price: candle.close,
            metadata: { rsi, prevRsi, stochRsi, trigger: 'rsi-stochrsi-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('rsi-stochrsi', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          rsi: () => createRSI({ period: rsiPeriod }),
          stochRsi: () => createStochRSI({ rsiPeriod, stochPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `rsi-stochrsi-${String(rsiPeriod)}-${String(stochPeriod)}-${String(oversold)}-${String(overbought)}`,
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
