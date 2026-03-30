/**
 * EMA Trend + RSI Entry — Multi-Timeframe Scanner Template
 *
 * Uses a 4h EMA as a trend filter: only enters when the lower-timeframe
 * RSI reversal signal agrees with the higher-timeframe trend direction.
 *
 * Two scanners:
 *   1. trend-4h — emits bullish/bearish based on close vs 4h EMA
 *   2. entry-rsi — emits RSI crossover signals on the entry timeframe
 *
 * The signalMerge function gates RSI entries: an ENTER_LONG from entry-rsi
 * only passes when trend-4h's latest signal is also ENTER_LONG, and vice versa
 * for shorts.
 *
 * Sweepable params:
 *   trendEmaPeriod: 10–100 (step 5)
 *   entryRsiPeriod: 5–30 (step 1)
 *   entryOversold: 15–35 (step 5)
 *   entryOverbought: 65–85 (step 5)
 */
import { createEMA, createRSI } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy } from '@trading-bot/strategy';
import type {
  ScannerEvaluate,
  ScannerTemplate,
  SignalMerge,
  Timeframe,
} from '@trading-bot/types';

const TREND_SCANNER_NAME = 'trend-4h';
const ENTRY_SCANNER_NAME = 'entry-rsi';
const TREND_TIMEFRAME: Timeframe = '4h';

export const emaTrendRsiEntry: ScannerTemplate = {
  name: 'ema-trend-rsi-entry',
  description: '4h EMA trend filter + RSI entry on lower timeframe. Only enters when trend direction agrees.',

  requiredTimeframes: [TREND_TIMEFRAME],

  params: {
    trendEmaPeriod: { min: 10, max: 100, step: 5 },
    entryRsiPeriod: { min: 5, max: 30, step: 1 },
    entryOversold: { min: 15, max: 35, step: 5 },
    entryOverbought: { min: 65, max: 85, step: 5 },
  },

  isValid: (params) => (params.entryOversold ?? 30) < (params.entryOverbought ?? 70),

  createFactory(symbols, timeframe, riskConfig, pmConfig) {
    return (params, deps) => {
      const trendEmaPeriod = params.trendEmaPeriod ?? 50;
      const entryRsiPeriod = params.entryRsiPeriod ?? 14;
      const entryOversold = params.entryOversold ?? 30;
      const entryOverbought = params.entryOverbought ?? 70;

      // ── Trend scanner (4h EMA) ──────────────────────────────────
      const trendEvaluate: ScannerEvaluate = (indicators, candle) => {
        const ema = indicators.ema;
        if (ema === undefined) return null;

        if (candle.close > ema) {
          return {
            action: 'ENTER_LONG',
            confidence: 0.5,
            price: candle.close,
            metadata: { trend: 'bullish', ema },
          };
        }

        if (candle.close < ema) {
          return {
            action: 'ENTER_SHORT',
            confidence: 0.5,
            price: candle.close,
            metadata: { trend: 'bearish', ema },
          };
        }

        return null;
      };

      const trendScannerFactory = createScannerFactory(TREND_SCANNER_NAME, trendEvaluate);
      const trendScanner = trendScannerFactory(deps.bus, {
        symbols,
        timeframe: TREND_TIMEFRAME,
        indicators: {
          ema: () => createEMA({ period: trendEmaPeriod }),
        },
      });

      // ── Entry scanner (RSI on entry timeframe) ──────────────────
      const prevRsiMap = new Map<string, number>();

      const entryEvaluate: ScannerEvaluate = (indicators, candle, symbol) => {
        const rsi = indicators.rsi;
        if (rsi === undefined) return null;

        const prevRsi = prevRsiMap.get(symbol) ?? null;
        prevRsiMap.set(symbol, rsi);

        if (prevRsi === null) return null;

        // LONG: RSI was at or below oversold, now crosses above
        if (prevRsi <= entryOversold && rsi > entryOversold) {
          return {
            action: 'ENTER_LONG',
            confidence: Math.min(1, (entryOversold - prevRsi + 5) / 20),
            price: candle.close,
            metadata: { rsi, prevRsi, trigger: 'oversold-reversal' },
          };
        }

        // SHORT: RSI was at or above overbought, now crosses below
        if (prevRsi >= entryOverbought && rsi < entryOverbought) {
          return {
            action: 'ENTER_SHORT',
            confidence: Math.min(1, (prevRsi - entryOverbought + 5) / 20),
            price: candle.close,
            metadata: { rsi, prevRsi, trigger: 'overbought-reversal' },
          };
        }

        return null;
      };

      const entryScannerFactory = createScannerFactory(ENTRY_SCANNER_NAME, entryEvaluate);
      const entryScanner = entryScannerFactory(deps.bus, {
        symbols,
        timeframe,
        indicators: {
          rsi: () => createRSI({ period: entryRsiPeriod }),
        },
      });

      // ── Signal merge: gate RSI entries by 4h trend ─────────────
      const signalMerge: SignalMerge = (trigger, buffer) => {
        // Don't act on trend signals directly — they're filters, not entries
        if (trigger.sourceScanner === TREND_SCANNER_NAME) {
          return null;
        }

        // Entry signal arrived — check if trend agrees
        if (trigger.sourceScanner === ENTRY_SCANNER_NAME) {
          const trendSignals = buffer.get(TREND_SCANNER_NAME);
          if (trendSignals === undefined || trendSignals.length === 0) {
            return null; // no trend established yet
          }

          // Latest trend signal
          const latestTrend = trendSignals[trendSignals.length - 1]!;

          // Only pass through if trend and entry agree on direction
          if (latestTrend.action === 'ENTER_LONG' && trigger.action === 'ENTER_LONG') {
            return trigger;
          }
          if (latestTrend.action === 'ENTER_SHORT' && trigger.action === 'ENTER_SHORT') {
            return trigger;
          }

          return null; // trend disagrees
        }

        return null;
      };

      // ── Wire into Strategy ──────────────────────────────────────
      const riskManager = new RiskManager(deps.bus, riskConfig);
      const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, deps.exchange, pmConfig);

      return new Strategy(
        {
          name: `ema-trend-rsi-${String(trendEmaPeriod)}-${String(entryRsiPeriod)}-${String(entryOversold)}-${String(entryOverbought)}`,
          symbols,
          scanners: [trendScanner, entryScanner],
          signalMerge,
          // Slightly over 4h to keep the trend signal alive across the full 4h window
          signalBufferWindowMs: 4 * 60 * 60 * 1000 + 60_000,
          positionManager,
          riskManager,
        },
        deps,
      );
    };
  },
};
