/**
 * Donchian Breakout + Volume Scanner Template
 *
 * Donchian Channel breakout with volume confirmation.
 * ENTER_LONG when donchian >= 0.95 (price pushing to range high) with volume spike.
 * ENTER_SHORT when donchian <= 0.05 (price pushing to range low) with volume spike.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Volume SMA is tracked manually in the evaluate closure because the SMA indicator
 * operates on candle.close, not candle.volume.
 *
 * Sweepable params:
 *   donchianPeriod: 10–30 (step 1)
 *   volSmaPeriod: 10–50 (step 5)
 *   volMultiplier: 1.2–3.0 (step 0.1)
 */
import { createDonchian } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const donchianVolBreakout: ScannerTemplate = {
  name: 'donchian-vol-breakout',
  description: 'Donchian Channel breakout with volume spike confirmation. Enters on new range highs/lows with above-average volume.',

  params: {
    donchianPeriod: { min: 10, max: 30, step: 1 },
    volSmaPeriod: { min: 10, max: 50, step: 5 },
    volMultiplier: { min: 1.2, max: 3.0, step: 0.1 },
  },

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const donchianPeriod = params.donchianPeriod ?? 20;
      const volSmaPeriod = params.volSmaPeriod ?? 20;
      const volMultiplier = params.volMultiplier ?? 1.5;

      const prevDonchianMap = new Map<string, number>();
      const volumeWindowMap = new Map<string, number[]>();

      const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const donchian = indicators.donchian;
        if (donchian === undefined) return null;

        // --- Volume SMA tracking (manual rolling window) ---
        let volWindow = volumeWindowMap.get(symbol);
        if (!volWindow) {
          volWindow = [];
          volumeWindowMap.set(symbol, volWindow);
        }
        volWindow.push(candle.volume);
        if (volWindow.length > volSmaPeriod) volWindow.shift();

        const prevDonchian = prevDonchianMap.get(symbol) ?? null;
        prevDonchianMap.set(symbol, donchian);

        if (prevDonchian === null) return null;
        if (volWindow.length < volSmaPeriod) return null;

        let volSum = 0;
        for (const v of volWindow) volSum += v;
        const volumeSma = volSum / volSmaPeriod;

        const volumeThreshold = volumeSma * volMultiplier;
        const volumeOk = candle.volume > volumeThreshold;

        // LONG: price pushing to range high with volume spike
        if (donchian >= 0.95 && prevDonchian < 0.95 && volumeOk) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, candle.volume / volumeThreshold),
            price: candle.close,
            metadata: { donchian, prevDonchian, volume: candle.volume, volumeSma, trigger: 'donchian-vol-long' },
          };
        }

        // SHORT: price pushing to range low with volume spike
        if (donchian <= 0.05 && prevDonchian > 0.05 && volumeOk) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, candle.volume / volumeThreshold),
            price: candle.close,
            metadata: { donchian, prevDonchian, volume: candle.volume, volumeSma, trigger: 'donchian-vol-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('donchian-vol-breakout', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          donchian: () => createDonchian({ period: donchianPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `donchian-vol-bo-${String(donchianPeriod)}-${String(volSmaPeriod)}`,
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
