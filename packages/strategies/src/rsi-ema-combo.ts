/**
 * RSI + EMA Combo Scanner Template
 *
 * Multi-indicator strategy: uses EMA for trend direction and RSI for entry timing.
 * ENTER_LONG when EMA trend is up (close > EMA) AND RSI crosses above oversold.
 * ENTER_SHORT when EMA trend is down (close < EMA) AND RSI crosses below overbought.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   emaPeriod: 10–50 (step 1)
 *   rsiPeriod: 5–20 (step 1)
 *   oversold: 20–35 (step 1)
 *   overbought: 65–80 (step 1)
 */
import { createEMA, createRSI } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const rsiEmaCombo: ScannerTemplate = {
  name: 'rsi-ema-combo',
  description: 'Enters on RSI reversal confirmed by EMA trend direction. Multi-indicator filter.',

  params: {
    emaPeriod: { min: 10, max: 50, step: 1 },
    rsiPeriod: { min: 5, max: 20, step: 1 },
    oversold: { min: 20, max: 35, step: 1 },
    overbought: { min: 65, max: 80, step: 1 },
  },

  isValid: (params) => (params.oversold ?? 30) < (params.overbought ?? 70),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const emaPeriod = params.emaPeriod ?? 20;
      const rsiPeriod = params.rsiPeriod ?? 14;
      const oversold = params.oversold ?? 30;
      const overbought = params.overbought ?? 70;

      const prevRsiMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const ema = indicators.ema;
        const rsi = indicators.rsi;
        if (ema === undefined || rsi === undefined) return null;

        const prevRsi = prevRsiMap.get(symbol) ?? null;
        prevRsiMap.set(symbol, rsi);

        if (prevRsi === null) return null;

        // LONG: EMA trend up (close > EMA) AND RSI crosses above oversold
        if (candle.close > ema && prevRsi <= oversold && rsi > oversold) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, (oversold - prevRsi + 5) / 20),
            price: candle.close,
            metadata: { ema, rsi, prevRsi, trigger: 'rsi-oversold-ema-up' },
          };
        }

        // SHORT: EMA trend down (close < EMA) AND RSI crosses below overbought
        if (candle.close < ema && prevRsi >= overbought && rsi < overbought) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, (prevRsi - overbought + 5) / 20),
            price: candle.close,
            metadata: { ema, rsi, prevRsi, trigger: 'rsi-overbought-ema-down' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('rsi-ema-combo', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          ema: () => createEMA({ period: emaPeriod }),
          rsi: () => createRSI({ period: rsiPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, pmConfig);

      return new Strategy(
        {
          name: `rsi-ema-${String(rsiPeriod)}-${String(emaPeriod)}-${String(oversold)}-${String(overbought)}`,
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
