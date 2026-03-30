/**
 * Z-Score Mean Reversion Scanner Template
 *
 * Statistical mean reversion using Z-score of price relative to rolling SMA.
 * ENTER_LONG when Z-score <= -entryZScore (price far below mean).
 * ENTER_SHORT when Z-score >= entryZScore (price far above mean).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Uses the SMA indicator for warmup signalling and maintains a manual rolling
 * window to compute standard deviation for Z-score calculation.
 *
 * Sweepable params:
 *   smaPeriod: 10–50 (step 5)
 *   entryZScore: 1.5–3.0 (step 0.1)
 */
import { createSMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const zscoreReversion: ScannerTemplate = {
  name: 'zscore-reversion',
  description: 'Z-score mean reversion. Enters when price deviates >N standard deviations from SMA, exits on mean reversion.',

  params: {
    smaPeriod: { min: 10, max: 50, step: 5 },
    entryZScore: { min: 1.5, max: 3.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const smaPeriod = params.smaPeriod ?? 20;
      const entryZScore = params.entryZScore ?? 2.0;

      const closeWindowMap = new Map<string, number[]>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const sma = indicators.sma;
        if (sma === undefined) return null;

        // --- Rolling close window for stddev ---
        let closeWindow = closeWindowMap.get(symbol);
        if (!closeWindow) {
          closeWindow = [];
          closeWindowMap.set(symbol, closeWindow);
        }
        closeWindow.push(candle.close);
        if (closeWindow.length > smaPeriod) closeWindow.shift();

        if (closeWindow.length < smaPeriod) return null;

        // mean = SMA indicator value
        const mean = sma;

        // stddev from the rolling window
        let sumSq = 0;
        for (const x of closeWindow) sumSq += (x - mean) ** 2;
        const stddev = Math.sqrt(sumSq / smaPeriod);

        if (stddev === 0) return null;

        const zscore = (candle.close - mean) / stddev;

        // LONG: Z-score <= -entryZScore (price far below mean)
        if (zscore <= -entryZScore) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, Math.abs(zscore) / (entryZScore + 1)),
            price: candle.close,
            metadata: { zscore, mean, stddev, trigger: 'zscore-long' },
          };
        }

        // SHORT: Z-score >= entryZScore (price far above mean)
        if (zscore >= entryZScore) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, Math.abs(zscore) / (entryZScore + 1)),
            price: candle.close,
            metadata: { zscore, mean, stddev, trigger: 'zscore-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('zscore-reversion', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          sma: () => createSMA({ period: smaPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `zscore-rev-${String(smaPeriod)}-${String(entryZScore)}`,
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
