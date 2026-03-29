import { describe, test, expect, beforeAll } from 'bun:test';

import { createEMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import { fixtures } from '@trading-bot/test-utils';
import type {
  BacktestConfig,
  BacktestResult,
  Candle,
  ExchangeConfig,
  PositionManagerConfig,
  RiskConfig,
  ScannerEvaluate,
  StrategyFactory,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { createBacktestEngine } from '@trading-bot/backtest-engine';

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

/**
 * 30 candles of flat/sideways prices (all close at 100).
 * Should produce zero trades — EMA crossover never fires on flat data.
 */
function makeFlatCandles(): Candle[] {
  return Array.from({ length: 30 }, (_, i) => ({
    symbol: BTCUSDT,
    openTime: BASE_TIME + i * CANDLE_MS,
    closeTime: BASE_TIME + (i + 1) * CANDLE_MS - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 500,
    quoteVolume: 50_000,
    trades: 50,
    isClosed: true,
  }));
}

// ─── EMA Crossover Strategy Factory ──────────────────────────────────

function makeEmaCrossoverFactory(
  riskCfg: RiskConfig,
  pmCfg: PositionManagerConfig,
  fastPeriod = 5,
  slowPeriod = 10,
): StrategyFactory {
  return (_params, deps) => {
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
  slippageModel: { type: 'fixed', fixedBps: 0 }, // zero slippage for determinism
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
// Test Suite 1: Golden Reference Backtest
// =====================================================================

describe('E2E Golden Reference Backtest', () => {
  const goldenCandles = makeGoldenCandles();

  const btConfig: BacktestConfig = {
    startTime: goldenCandles[0]!.openTime,
    endTime: goldenCandles[goldenCandles.length - 1]!.closeTime + 1,
    symbols: [BTCUSDT],
    timeframes: ['1m'],
  };

  const loader = async () => goldenCandles;
  const factory = makeEmaCrossoverFactory(riskConfig, pmConfig, 5, 10);

  // Run once, assert many — no need to repeat 8 full backtests
  let result: BacktestResult;
  beforeAll(async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    result = await engine.run(factory, {}, btConfig);
  });

  test('produces exactly 2 deterministic trades', () => {
    expect(result.trades.length).toBe(2);
  });

  test('trade 0 is SHORT, closed by TAKE_PROFIT', () => {
    const t0 = result.trades[0]!;
    expect(t0.side).toBe('SHORT');
    expect(t0.exitReason).toBe('TAKE_PROFIT');
    expect(t0.entryPrice).toBe(170);
    expect(t0.exitPrice).toBe(153);
    expect(t0.pnl).toBeGreaterThan(0);
  });

  test('trade 1 is LONG, closed by TAKE_PROFIT', () => {
    const t1 = result.trades[1]!;
    expect(t1.side).toBe('LONG');
    expect(t1.exitReason).toBe('TAKE_PROFIT');
    expect(t1.entryPrice).toBe(155);
    expect(t1.exitPrice).toBe(170.5);
    expect(t1.pnl).toBeGreaterThan(0);
  });

  test('trade ordering: t0 entry before t1 entry, no overlap (maxConcurrentPositions=1)', () => {
    const t0 = result.trades[0]!;
    const t1 = result.trades[1]!;
    expect(t0.entryTime).toBeLessThan(t1.entryTime);
    // NOTE: The stronger assertion would be t0.exitTime <= t1.entryTime (no overlap).
    // Currently exitTime uses Date.now() in BacktestSimExchange.makeFilled() instead of
    // simulation time, making exit timestamps non-deterministic and incomparable with
    // entry timestamps. This is a known design issue — sim exchange should use candle
    // timestamps for fills. For now, entry ordering proves sequential execution.
  });

  test('all trades have non-zero fees', () => {
    for (const trade of result.trades) {
      expect(trade.fees).toBeGreaterThan(0);
    }
  });

  test('pinned finalBalance and initialBalance', () => {
    expect(result.initialBalance).toBe(10_000);
    // Zero slippage + deterministic fees = exact IEEE 754 float.
    // If this breaks, a fee/fill calculation changed.
    expect(result.finalBalance).toBe(10199.38406384);
  });

  test('metrics match trades', () => {
    expect(result.metrics.totalTrades).toBe(2);
    expect(result.metrics.totalTrades).toBe(result.trades.length);
    expect(result.metrics.winRate).toBe(1); // both trades are winners
  });

  test('each trade has valid exit reason and side', () => {
    const validExitReasons = new Set([
      'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP', 'SIGNAL', 'TIMEOUT', 'FORCED',
    ]);
    for (const trade of result.trades) {
      expect(validExitReasons.has(trade.exitReason)).toBe(true);
      expect(['LONG', 'SHORT']).toContain(trade.side);
    }
  });
});

// =====================================================================
// Test Suite 2: Negative Paths
// =====================================================================

describe('E2E Negative Paths', () => {
  test('flat/sideways data produces zero trades, balance unchanged', async () => {
    const flatCandles = makeFlatCandles();
    const btConfig: BacktestConfig = {
      startTime: flatCandles[0]!.openTime,
      endTime: flatCandles[flatCandles.length - 1]!.closeTime + 1,
      symbols: [BTCUSDT],
      timeframes: ['1m'],
    };
    const loader = async () => flatCandles;
    const factory = makeEmaCrossoverFactory(riskConfig, pmConfig, 5, 10);
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    expect(result.trades.length).toBe(0);
    expect(result.finalBalance).toBe(10_000);
    expect(result.metrics.totalTrades).toBe(0);
    expect(result.metrics.winRate).toBe(0);
  });

  test('stop-loss fires when SL is tight on golden data (pinned)', async () => {
    // Golden data: up (0-19), down (20-34), up again (35-49).
    // Bearish crossover fires a SHORT near the peak. The second uptrend
    // (candles 35-49) pushes price above the 2% SL, closing the position.
    const goldenCandles = makeGoldenCandles();
    const btConfig: BacktestConfig = {
      startTime: goldenCandles[0]!.openTime,
      endTime: goldenCandles[goldenCandles.length - 1]!.closeTime + 1,
      symbols: [BTCUSDT],
      timeframes: ['1m'],
    };
    const loader = async () => goldenCandles;
    const slPmConfig: PositionManagerConfig = {
      ...pmConfig,
      defaultStopLossPct: 2,
      defaultTakeProfitPct: 50,
    };
    const factory = makeEmaCrossoverFactory(riskConfig, slPmConfig, 5, 10);
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    // Pinned: exactly 1 trade, SHORT, hit STOP_LOSS at 173.4
    expect(result.trades.length).toBe(1);
    const t0 = result.trades[0]!;
    expect(t0.side).toBe('SHORT');
    expect(t0.exitReason).toBe('STOP_LOSS');
    expect(t0.entryPrice).toBe(170);
    expect(t0.exitPrice).toBe(173.4);
    expect(t0.pnl).toBeLessThan(0);
  });

  test('fewer candles than slow EMA period produces zero trades', async () => {
    const goldenCandles = makeGoldenCandles();
    const shortCandles = goldenCandles.slice(0, 5); // only 5 candles, slow EMA needs 10
    const btConfig: BacktestConfig = {
      startTime: shortCandles[0]!.openTime,
      endTime: shortCandles[shortCandles.length - 1]!.closeTime + 1,
      symbols: [BTCUSDT],
      timeframes: ['1m'],
    };
    const loader = async () => shortCandles;
    const factory = makeEmaCrossoverFactory(riskConfig, pmConfig, 5, 10);
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    expect(result.trades.length).toBe(0);
    expect(result.initialBalance).toBe(10_000);
    expect(result.finalBalance).toBe(10_000);
  });

  test('monotonic fixture data (~50k prices) produces zero trades, no NaN metrics', async () => {
    // Fixture candles are monotonically increasing (~50020 to ~51010).
    // A pure crossover never fires — same zero-trade outcome as flat data,
    // but exercises the engine with realistic price magnitudes.
    const fixtureCandles = fixtures.candles;
    const fixtureSymbol = fixtureCandles[0]!.symbol;
    // Guard: if fixture symbol changes, this test would silently pass for the wrong reason
    expect(fixtureSymbol).toBe(BTCUSDT);

    const btConfig: BacktestConfig = {
      startTime: fixtureCandles[0]!.openTime,
      endTime: fixtureCandles[fixtureCandles.length - 1]!.closeTime + 1,
      symbols: [fixtureSymbol],
      timeframes: ['1m'],
    };
    const loader = async () => fixtureCandles;
    const factory = makeEmaCrossoverFactory(riskConfig, pmConfig, 5, 10);
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    expect(result.trades.length).toBe(0);
    expect(result.initialBalance).toBe(10_000);
    expect(result.finalBalance).toBe(10_000);
    expect(result.metrics.totalTrades).toBe(0);
    expect(Number.isNaN(result.metrics.sharpeRatio)).toBe(false);
    expect(Number.isNaN(result.metrics.profitFactor)).toBe(false);
  });
});
