/**
 * Bollinger Band Squeeze + ATR Scanner Template
 *
 * Bollinger Band squeeze breakout confirmed by ATR expansion.
 * ENTER_LONG when %B crosses above 1.0 (price breaks upper band) AND ATR expanding.
 * ENTER_SHORT when %B crosses below 0.0 (price breaks lower band) AND ATR expanding.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   bbPeriod: 10–30 (step 1)
 *   bbStdDev: 1.5–3.0 (step 0.1)
 *   atrPeriod: 5–20 (step 1)
 *   atrExpansionMult: 1.1–2.0 (step 0.1)
 */
import { createATR, createBollinger } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const bbAtrSqueeze: ScannerTemplate = {
  name: 'bb-atr-squeeze',
  description: 'Bollinger Band breakout with ATR expansion filter. Catches volatility expansion after squeeze periods.',

  params: {
    bbPeriod: { min: 10, max: 30, step: 1 },
    bbStdDev: { min: 1.5, max: 3.0, step: 0.1 },
    atrPeriod: { min: 5, max: 20, step: 1 },
    atrExpansionMult: { min: 1.1, max: 2.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const bbPeriod = params.bbPeriod ?? 20;
      const bbStdDev = params.bbStdDev ?? 2.0;
      const atrPeriod = params.atrPeriod ?? 14;
      const atrExpansionMult = params.atrExpansionMult ?? 1.5;

      const prevBBMap = new Map<string, number>();
      const prevATRMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const bb = indicators.bb;
        const atr = indicators.atr;
        if (bb === undefined || atr === undefined) return null;

        const prevBB = prevBBMap.get(symbol) ?? null;
        const prevATR = prevATRMap.get(symbol) ?? null;
        prevBBMap.set(symbol, bb);
        prevATRMap.set(symbol, atr);

        if (prevBB === null || prevATR === null) return null;

        const atrExpanding = atr > prevATR * atrExpansionMult;

        // LONG: %B crosses above 1.0 (price breaks upper band) AND ATR expanding
        if (prevBB <= 1.0 && bb > 1.0 && atrExpanding) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, Math.abs(bb - 0.5) * 2),
            price: candle.close,
            metadata: { bb, prevBB, atr, prevATR, trigger: 'bb-squeeze-long' },
          };
        }

        // SHORT: %B crosses below 0.0 (price breaks lower band) AND ATR expanding
        if (prevBB >= 0.0 && bb < 0.0 && atrExpanding) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, Math.abs(bb - 0.5) * 2),
            price: candle.close,
            metadata: { bb, prevBB, atr, prevATR, trigger: 'bb-squeeze-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('bb-atr-squeeze', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          bb: () => createBollinger({ period: bbPeriod, stdDevMultiplier: bbStdDev }),
          atr: () => createATR({ period: atrPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `bb-atr-sq-${String(bbPeriod)}-${String(bbStdDev)}-${String(atrPeriod)}`,
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
