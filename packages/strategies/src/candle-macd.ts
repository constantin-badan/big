/**
 * Consecutive Candle + MACD Confluence Scanner Template
 *
 * Consecutive same-direction candles confirmed by MACD trend agreement.
 * ENTER_LONG when N consecutive bullish candles AND MACD histogram > 0.
 * ENTER_SHORT when N consecutive bearish candles AND MACD histogram < 0.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   consecutiveCount: 2–6 (step 1)
 *   fastPeriod: 8–20 (step 1)
 *   slowPeriod: 20–40 (step 1)
 *   signalPeriod: 5–15 (step 1)
 */
import { createMACD } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const candleMacd: ScannerTemplate = {
  name: 'candle-macd',
  description: 'Consecutive bullish/bearish candles with MACD histogram confirmation. Trend-following momentum entry.',

  params: {
    consecutiveCount: { min: 2, max: 6, step: 1 },
    fastPeriod: { min: 8, max: 20, step: 1 },
    slowPeriod: { min: 20, max: 40, step: 1 },
    signalPeriod: { min: 5, max: 15, step: 1 },
  },

  isValid: (params) => (params.fastPeriod ?? 12) < (params.slowPeriod ?? 26),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const consecutiveCount = params.consecutiveCount ?? 3;
      const fastPeriod = params.fastPeriod ?? 12;
      const slowPeriod = params.slowPeriod ?? 26;
      const signalPeriod = params.signalPeriod ?? 9;

      const bullishStreakMap = new Map<string, number>();
      const bearishStreakMap = new Map<string, number>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const macd = indicators.macd;
        if (macd === undefined) return null;

        let bullishStreak = bullishStreakMap.get(symbol) ?? 0;
        let bearishStreak = bearishStreakMap.get(symbol) ?? 0;

        // Update streaks
        if (candle.close > candle.open) {
          bullishStreak += 1;
          bearishStreak = 0;
        } else if (candle.close < candle.open) {
          bearishStreak += 1;
          bullishStreak = 0;
        } else {
          // Doji — reset both
          bullishStreak = 0;
          bearishStreak = 0;
        }

        bullishStreakMap.set(symbol, bullishStreak);
        bearishStreakMap.set(symbol, bearishStreak);

        // LONG: consecutive bullish candles AND MACD histogram positive
        if (bullishStreak >= consecutiveCount && macd > 0) {
          bullishStreakMap.set(symbol, 0);
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, bullishStreak / (consecutiveCount + 2)),
            price: candle.close,
            metadata: { bullishStreak, macd, trigger: 'candle-macd-long' },
          };
        }

        // SHORT: consecutive bearish candles AND MACD histogram negative
        if (bearishStreak >= consecutiveCount && macd < 0) {
          bearishStreakMap.set(symbol, 0);
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, bearishStreak / (consecutiveCount + 2)),
            price: candle.close,
            metadata: { bearishStreak, macd, trigger: 'candle-macd-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('candle-macd', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          macd: () => createMACD({ fastPeriod, slowPeriod, signalPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `candle-macd-${String(consecutiveCount)}-${String(fastPeriod)}-${String(slowPeriod)}`,
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
