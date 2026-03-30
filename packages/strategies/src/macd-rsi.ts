/**
 * MACD + RSI Confluence Scanner Template
 *
 * MACD histogram direction combined with RSI oversold/overbought for high-quality entries.
 * ENTER_LONG when histogram > 0 (bullish momentum) AND RSI <= oversold (oversold dip).
 * ENTER_SHORT when histogram < 0 (bearish momentum) AND RSI >= overbought (overbought top).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   fastPeriod: 8–16 (step 1)
 *   slowPeriod: 20–35 (step 1)
 *   signalPeriod: 5–12 (step 1)
 *   rsiPeriod: 7–21 (step 1)
 *   oversold: 20–40 (step 5)
 *   overbought: 60–80 (step 5)
 */
import { createMACD, createRSI } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const macdRsi: ScannerTemplate = {
  name: 'macd-rsi',
  description: 'MACD histogram + RSI confluence. Enters when momentum (MACD) and mean reversion (RSI) agree.',

  params: {
    fastPeriod: { min: 8, max: 16, step: 1 },
    slowPeriod: { min: 20, max: 35, step: 1 },
    signalPeriod: { min: 5, max: 12, step: 1 },
    rsiPeriod: { min: 7, max: 21, step: 1 },
    oversold: { min: 20, max: 40, step: 5 },
    overbought: { min: 60, max: 80, step: 5 },
  },

  isValid: (params) =>
    (params.fastPeriod ?? 12) < (params.slowPeriod ?? 26) &&
    (params.oversold ?? 30) < (params.overbought ?? 70),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const fastPeriod = params.fastPeriod ?? 12;
      const slowPeriod = params.slowPeriod ?? 26;
      const signalPeriod = params.signalPeriod ?? 9;
      const rsiPeriod = params.rsiPeriod ?? 14;
      const oversold = params.oversold ?? 30;
      const overbought = params.overbought ?? 70;

      const evaluate: ScannerEvaluate = (indicators, candle, _symbol) => {
        const macd = indicators.macd;
        const rsi = indicators.rsi;
        if (macd === undefined || rsi === undefined) return null;

        // LONG: bullish momentum (histogram > 0) AND RSI oversold
        if (macd > 0 && rsi <= oversold) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, (Math.abs(macd) / 5 + Math.abs(rsi - 50) / 50) / 2),
            price: candle.close,
            metadata: { macd, rsi, trigger: 'macd-rsi-long' },
          };
        }

        // SHORT: bearish momentum (histogram < 0) AND RSI overbought
        if (macd < 0 && rsi >= overbought) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, (Math.abs(macd) / 5 + Math.abs(rsi - 50) / 50) / 2),
            price: candle.close,
            metadata: { macd, rsi, trigger: 'macd-rsi-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('macd-rsi', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          macd: () => createMACD({ fastPeriod, slowPeriod, signalPeriod }),
          rsi: () => createRSI({ period: rsiPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `macd-rsi-${String(fastPeriod)}-${String(slowPeriod)}-${String(rsiPeriod)}`,
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
