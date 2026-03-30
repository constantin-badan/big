/**
 * ATR Breakout Scanner Template
 *
 * Detects volatility breakout conditions using ATR.
 * ENTER_LONG when close > prevClose + atrMultiplier * ATR (price breaks above ATR band).
 * ENTER_SHORT when close < prevClose - atrMultiplier * ATR (price breaks below ATR band).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   atrPeriod: 5–30 (step 1)
 *   atrMultiplier: 1.0–3.0 (step 0.1)
 */
import { createATR } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const atrBreakout: ScannerTemplate = {
  name: 'atr-breakout',
  description: 'Enters on ATR volatility breakout. Price breaking ATR band = trend start.',

  params: {
    atrPeriod: { min: 5, max: 30, step: 1 },
    atrMultiplier: { min: 1.0, max: 3.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const atrPeriod = params.atrPeriod ?? 14;
      const atrMultiplier = params.atrMultiplier ?? 2.0;

      const prevCloseMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const atr = indicators.atr;
        if (atr === undefined) return null;

        const prevClose = prevCloseMap.get(symbol) ?? null;
        prevCloseMap.set(symbol, candle.close);

        if (prevClose === null) return null;

        const breakoutThreshold = atrMultiplier * atr;

        // LONG: price breaks above previous close + ATR band
        if (candle.close > prevClose + breakoutThreshold) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, (candle.close - prevClose) / breakoutThreshold),
            price: candle.close,
            metadata: { atr, prevClose, breakoutThreshold, trigger: 'atr-breakout-long' },
          };
        }

        // SHORT: price breaks below previous close - ATR band
        if (candle.close < prevClose - breakoutThreshold) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, (prevClose - candle.close) / breakoutThreshold),
            price: candle.close,
            metadata: { atr, prevClose, breakoutThreshold, trigger: 'atr-breakout-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('atr-breakout', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          atr: () => createATR({ period: atrPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `atr-bo-${String(atrPeriod)}-${String(atrMultiplier)}`,
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
