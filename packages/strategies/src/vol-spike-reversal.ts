/**
 * Volume Spike Reversal Scanner Template
 *
 * Large volume spike with reversal candle pattern — high volume exhaustion.
 * ENTER_LONG when volume spikes AND bullish reversal candle (green after red).
 * ENTER_SHORT when volume spikes AND bearish reversal candle (red after green).
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Volume SMA is tracked manually in the evaluate closure because the SMA indicator
 * operates on candle.close, not candle.volume.
 *
 * Sweepable params:
 *   volSmaPeriod: 10–50 (step 5)
 *   volMultiplier: 1.5–4.0 (step 0.5)
 *   bodyRatio: 0.3–0.7 (step 0.1)
 */
import { createSMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  Candle,
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const volSpikeReversal: ScannerTemplate = {
  name: 'vol-spike-reversal',
  description: 'Volume spike + reversal candle. Enters on exhaustion after high-volume directional move reverses.',

  params: {
    volSmaPeriod: { min: 10, max: 50, step: 5 },
    volMultiplier: { min: 1.5, max: 4.0, step: 0.5 },
    bodyRatio: { min: 0.3, max: 0.7, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const volSmaPeriod = params.volSmaPeriod ?? 20;
      const volMultiplier = params.volMultiplier ?? 2.0;
      const bodyRatio = params.bodyRatio ?? 0.5;

      const prevCandleMap = new Map<string, Candle>();
      const volumeWindowMap = new Map<string, number[]>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        // --- Volume SMA tracking (manual rolling window) ---
        let volWindow = volumeWindowMap.get(symbol);
        if (!volWindow) {
          volWindow = [];
          volumeWindowMap.set(symbol, volWindow);
        }
        volWindow.push(candle.volume);
        if (volWindow.length > volSmaPeriod) volWindow.shift();

        const prevCandle = prevCandleMap.get(symbol) ?? null;
        prevCandleMap.set(symbol, candle);

        if (prevCandle === null) return null;
        if (volWindow.length < volSmaPeriod) return null;

        let volSum = 0;
        for (const v of volWindow) volSum += v;
        const volumeSma = volSum / volSmaPeriod;

        const volumeThreshold = volumeSma * volMultiplier;
        const volumeSpike = candle.volume > volumeThreshold;

        if (!volumeSpike) return null;

        // Candle body and range
        const candleRange = candle.high - candle.low;
        if (candleRange === 0) return null;
        const candleBody = Math.abs(candle.close - candle.open);
        const ratio = candleBody / candleRange;

        if (ratio < bodyRatio) return null;

        const isBullish = candle.close > candle.open;
        const prevBearish = prevCandle.close < prevCandle.open;
        const isBearish = candle.close < candle.open;
        const prevBullish = prevCandle.close > prevCandle.open;

        // LONG: bullish reversal candle (green after red) with volume spike
        if (isBullish && prevBearish) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, candle.volume / volumeThreshold),
            price: candle.close,
            metadata: { volumeSma, volume: candle.volume, ratio, trigger: 'vol-spike-reversal-long' },
          };
        }

        // SHORT: bearish reversal candle (red after green) with volume spike
        if (isBearish && prevBullish) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, candle.volume / volumeThreshold),
            price: candle.close,
            metadata: { volumeSma, volume: candle.volume, ratio, trigger: 'vol-spike-reversal-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('vol-spike-reversal', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          _warmup: () => createSMA({ period: volSmaPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `vol-spike-rev-${String(volSmaPeriod)}-${String(volMultiplier)}-${String(bodyRatio)}`,
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
