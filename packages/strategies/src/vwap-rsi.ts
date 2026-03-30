/**
 * VWAP + RSI Confluence Scanner Template
 *
 * Combines VWAP deviation with RSI oversold/overbought for higher-quality entries.
 * ENTER_LONG when price below VWAP by deviationPct AND RSI <= oversold.
 * ENTER_SHORT when price above VWAP by deviationPct AND RSI >= overbought.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Sweepable params:
 *   deviationPct: 0.5–3.0 (step 0.1)
 *   rsiPeriod: 7–21 (step 1)
 *   oversold: 20–40 (step 5)
 *   overbought: 60–80 (step 5)
 */
import { createVWAP, createRSI } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
} from '@trading-bot/types';

export const vwapRsi: ScannerTemplate = {
  name: 'vwap-rsi',
  description: 'VWAP deviation + RSI confluence. Only enters VWAP mean reversion when RSI confirms oversold/overbought.',

  params: {
    deviationPct: { min: 0.5, max: 3.0, step: 0.1 },
    rsiPeriod: { min: 7, max: 21, step: 1 },
    oversold: { min: 20, max: 40, step: 5 },
    overbought: { min: 60, max: 80, step: 5 },
  },

  isValid: (params) => (params.oversold ?? 30) < (params.overbought ?? 70),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const deviationPct = params.deviationPct ?? 1.5;
      const rsiPeriod = params.rsiPeriod ?? 14;
      const oversold = params.oversold ?? 30;
      const overbought = params.overbought ?? 70;

      const evaluate: ScannerEvaluate = (indicators, candle, _symbol) => {
        const vwap = indicators.vwap;
        const rsi = indicators.rsi;
        if (vwap === undefined || vwap === 0 || rsi === undefined) return null;

        const vwapDev = ((candle.close - vwap) / vwap) * 100;

        // LONG: below VWAP by deviationPct AND RSI oversold
        if (vwapDev <= -deviationPct && rsi <= oversold) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, (Math.abs(vwapDev) / deviationPct + (100 - rsi) / 50) / 2),
            price: candle.close,
            metadata: { vwap, rsi, vwapDev, trigger: 'vwap-rsi-long' },
          };
        }

        // SHORT: above VWAP by deviationPct AND RSI overbought
        if (vwapDev >= deviationPct && rsi >= overbought) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, (Math.abs(vwapDev) / deviationPct + rsi / 50) / 2),
            price: candle.close,
            metadata: { vwap, rsi, vwapDev, trigger: 'vwap-rsi-short' },
          };
        }

        return null;
      };

      const scannerFactory = createScannerFactory('vwap-rsi', evaluate);
      const scanner = scannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          vwap: () => createVWAP({}),
          rsi: () => createRSI({ period: rsiPeriod }),
        },
      });

      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `vwap-rsi-${String(deviationPct)}-${String(rsiPeriod)}`,
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
