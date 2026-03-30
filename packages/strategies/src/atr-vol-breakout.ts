/**
 * ATR + Volume Breakout Scanner Template
 *
 * Combines volatility breakout with volume confirmation.
 * ENTER_LONG when close > prevClose + atrMultiplier * ATR AND volume spikes above SMA.
 * ENTER_SHORT when close < prevClose - atrMultiplier * ATR AND volume spikes above SMA.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Volume SMA is tracked manually in the evaluate closure because the SMA indicator
 * operates on candle.close, not candle.volume.
 *
 * Sweepable params:
 *   atrPeriod: 5–30 (step 1)
 *   atrMultiplier: 1.0–3.0 (step 0.1)
 *   volSmaPeriod: 10–50 (step 5)
 *   volMultiplier: 1.2–3.0 (step 0.1)
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

export const atrVolBreakout: ScannerTemplate = {
  name: 'atr-vol-breakout',
  description: 'ATR breakout confirmed by volume spike. Filters false breakouts in low-volume conditions.',

  params: {
    atrPeriod: { min: 5, max: 30, step: 1 },
    atrMultiplier: { min: 1.0, max: 3.0, step: 0.1 },
    volSmaPeriod: { min: 10, max: 50, step: 5 },
    volMultiplier: { min: 1.2, max: 3.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const atrPeriod = params.atrPeriod ?? 14;
      const atrMultiplier = params.atrMultiplier ?? 2.0;
      const volSmaPeriod = params.volSmaPeriod ?? 20;
      const volMultiplier = params.volMultiplier ?? 1.5;

      const prevCloseMap = new Map<string, number>();
      const volumeWindowMap = new Map<string, number[]>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const atr = indicators.atr;
        if (atr === undefined) return null;

        // --- Volume SMA tracking (manual rolling window) ---
        let volWindow = volumeWindowMap.get(symbol);
        if (!volWindow) {
          volWindow = [];
          volumeWindowMap.set(symbol, volWindow);
        }
        volWindow.push(candle.volume);
        if (volWindow.length > volSmaPeriod) volWindow.shift();

        const prevClose = prevCloseMap.get(symbol) ?? null;
        prevCloseMap.set(symbol, candle.close);

        if (prevClose === null) return null;
        if (volWindow.length < volSmaPeriod) return null;

        let volSum = 0;
        for (const v of volWindow) volSum += v;
        const volumeSma = volSum / volSmaPeriod;

        const breakoutThreshold = atrMultiplier * atr;
        const volumeThreshold = volumeSma * volMultiplier;
        const volumeOk = candle.volume > volumeThreshold;

        // LONG: price breaks above previous close + ATR band AND volume spike
        if (candle.close > prevClose + breakoutThreshold && volumeOk) {
          const breakoutSize = candle.close - prevClose;
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, (breakoutSize / breakoutThreshold) * (candle.volume / volumeThreshold)) / 2,
            price: candle.close,
            metadata: { atr, prevClose, breakoutThreshold, volumeSma, trigger: 'atr-vol-breakout-long' },
          };
        }

        // SHORT: price breaks below previous close - ATR band AND volume spike
        if (candle.close < prevClose - breakoutThreshold && volumeOk) {
          const breakoutSize = prevClose - candle.close;
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, (breakoutSize / breakoutThreshold) * (candle.volume / volumeThreshold)) / 2,
            price: candle.close,
            metadata: { atr, prevClose, breakoutThreshold, volumeSma, trigger: 'atr-vol-breakout-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('atr-vol-breakout', evaluate);
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
          name: `atr-vol-bo-${String(atrPeriod)}-${String(atrMultiplier)}-${String(volSmaPeriod)}`,
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
