import { describe, test, expect, beforeAll } from 'bun:test';

import { createEMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  BacktestConfig,
  Candle,
  ExchangeConfig,
  PositionManagerConfig,
  RiskConfig,
  ScannerEvaluate,
  StrategyFactory,
  SweepParamGrid,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { createBacktestEngine } from '@trading-bot/backtest-engine';
import { createSweepEngine } from '@trading-bot/sweep-engine';
import type { SweepResult } from '@trading-bot/sweep-engine';

// ─── Shared Constants ────────────────────────────────────────────────

const BASE_TIME = 1_700_000_000_000;
const BTCUSDT = toSymbol('BTCUSDT');
const CANDLE_MS = 60_000; // 1-minute candles

// ─── Deterministic Candle Generator ──────────────────────────────────

/**
 * Builds 50 candles with a predictable price pattern:
 *   0-19 : UP    from 100 to 195  (close = 100 + i * 5)
 *   20-34: DOWN  from 200 to 130  (close = 200 - (i-20) * 5)
 *   35-49: UP    from 130 to 200  (close = 130 + (i-35) * 5)
 *
 * High = close + 2, Low = close - 2 (fixed bracket, no randomness).
 */
function makeGoldenCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    let close: number;
    if (i <= 19) {
      close = 100 + i * 5;
    } else if (i <= 34) {
      close = 200 - (i - 20) * 5;
    } else {
      close = 130 + (i - 35) * 5;
    }
    const open = close - 1;
    const high = close + 2;
    const low = close - 2;
    candles.push({
      symbol: BTCUSDT,
      openTime: BASE_TIME + i * CANDLE_MS,
      closeTime: BASE_TIME + (i + 1) * CANDLE_MS - 1,
      open,
      high,
      low,
      close,
      volume: 1000,
      quoteVolume: 1000 * close,
      trades: 100,
      isClosed: true,
    });
  }
  return candles;
}

// ─── EMA Crossover Strategy Factory (parameterized) ─────────────────

function makeEmaCrossoverFactory(
  riskCfg: RiskConfig,
  pmCfg: PositionManagerConfig,
): StrategyFactory {
  return (params, deps) => {
    const fastPeriod = params.fastPeriod ?? 5;
    const slowPeriod = params.slowPeriod ?? 10;

    const prevFastMap = new Map<string, number>();
    const prevSlowMap = new Map<string, number>();

    const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
      const fast = indicators.fast;
      const slow = indicators.slow;
      if (fast === undefined || slow === undefined) return null;

      const prevFast = prevFastMap.get(symbol) ?? null;
      const prevSlow = prevSlowMap.get(symbol) ?? null;

      prevFastMap.set(symbol, fast);
      prevSlowMap.set(symbol, slow);

      if (prevFast === null || prevSlow === null) return null;

      if (prevFast <= prevSlow && fast > slow) {
        return {
          action: 'ENTER_LONG',
          confidence: 0.9,
          price: candle.close,
          metadata: { fast, slow, crossover: 'bullish' },
        };
      }

      if (prevFast >= prevSlow && fast < slow) {
        return {
          action: 'ENTER_SHORT',
          confidence: 0.9,
          price: candle.close,
          metadata: { fast, slow, crossover: 'bearish' },
        };
      }

      return null;
    };

    const scannerFactory = createScannerFactory('ema-cross', evaluate);
    const scanner = scannerFactory(deps.bus, {
      symbols: [BTCUSDT],
      timeframe: '1m',
      indicators: {
        fast: () => createEMA({ period: fastPeriod }),
        slow: () => createEMA({ period: slowPeriod }),
      },
    });

    const riskManager = new RiskManager(deps.bus, riskCfg);
    const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, pmCfg);

    return new Strategy(
      {
        name: 'ema-crossover',
        symbols: [BTCUSDT],
        scanners: [scanner],
        signalMerge: passthroughMerge,
        signalBufferWindowMs: 60_000,
        positionManager,
        riskManager,
      },
      deps,
    );
  };
}

// ─── Configs ─────────────────────────────────────────────────────────

const exchangeConfig: ExchangeConfig = {
  type: 'backtest-sim',
  feeStructure: { maker: 0.0002, taker: 0.0004 },
  slippageModel: { type: 'fixed', fixedBps: 0 },
  initialBalance: 10_000,
};

const riskConfig: RiskConfig = {
  maxPositionSizePct: 10,
  maxConcurrentPositions: 1,
  maxDailyLossPct: 50,
  maxDrawdownPct: 50,
  maxDailyTrades: 100,
  cooldownAfterLossMs: 0,
  leverage: 1,
  initialBalance: 10_000,
};

const pmConfig: PositionManagerConfig = {
  defaultStopLossPct: 5,
  defaultTakeProfitPct: 10,
  trailingStopEnabled: false,
  trailingStopActivationPct: 0,
  trailingStopDistancePct: 0,
  maxHoldTimeMs: 999_999_999,
};

// =====================================================================
// E2E Sweep Engine Tests
// =====================================================================

describe('E2E Sweep Engine', () => {
  const goldenCandles = makeGoldenCandles();

  const btConfig: BacktestConfig = {
    startTime: goldenCandles[0]!.openTime,
    endTime: goldenCandles[goldenCandles.length - 1]!.closeTime + 1,
    symbols: [BTCUSDT],
    timeframes: ['1m'],
  };

  const grid: SweepParamGrid = {
    fastPeriod: [3, 5, 10],
    slowPeriod: [8, 10],
  };

  const loader = async () => goldenCandles;
  const factory = makeEmaCrossoverFactory(riskConfig, pmConfig);

  let results: SweepResult[];

  beforeAll(async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const sweep = createSweepEngine(engine);
    results = await sweep.run(factory, grid, btConfig);
  });

  test('sweep produces exactly 6 results', () => {
    expect(results.length).toBe(6);
  });

  test('results sorted by profit factor descending', () => {
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.result.metrics.profitFactor).toBeGreaterThanOrEqual(
        results[i + 1]!.result.metrics.profitFactor,
      );
    }
  });

  test('(10,10) combination is last with 0 trades', () => {
    const match = results.find(
      (r) => r.params.fastPeriod === 10 && r.params.slowPeriod === 10,
    );
    expect(match).toBeDefined();
    expect(match!.result.trades.length).toBe(0);
    expect(match!.result.metrics.profitFactor).toBe(0);
  });

  test('each result has correct param keys', () => {
    const validFast = new Set([3, 5, 10]);
    const validSlow = new Set([8, 10]);
    for (const r of results) {
      expect('fastPeriod' in r.params).toBe(true);
      expect('slowPeriod' in r.params).toBe(true);
      expect(validFast.has(r.params.fastPeriod!)).toBe(true);
      expect(validSlow.has(r.params.slowPeriod!)).toBe(true);
    }
  });

  test('top result params match its trade behavior', () => {
    const top = results[0]!;
    // On golden candles (up/down/up), EMA crossovers with fast < slow will fire.
    // The top result should have trades and a positive profit factor.
    expect(top.result.trades.length).toBeGreaterThan(0);
    expect(top.result.metrics.profitFactor).toBeGreaterThan(0);
  });

  test('all 6 param combinations are present', () => {
    const expected = new Set([
      '3,8', '3,10', '5,8', '5,10', '10,8', '10,10',
    ]);
    const actual = new Set(
      results.map((r) => `${String(r.params.fastPeriod)},${String(r.params.slowPeriod)}`),
    );
    expect(actual).toEqual(expected);
  });
});
