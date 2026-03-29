import { describe, test, expect } from 'bun:test';

import { createEMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import type { ScannerEvaluate } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type { StrategyFactory } from '@trading-bot/strategy';
import { fixtures } from '@trading-bot/test-utils';
import type {
  Candle,
  ExchangeConfig,
  BacktestConfig,
  PositionManagerConfig,
  RiskConfig,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { createBacktestEngine } from '../backtest-engine';

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
    const open = close - 1; // deterministic, slightly below close
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

// ─── EMA Crossover Strategy Factory ──────────────────────────────────

/**
 * Builds a StrategyFactory that uses EMA crossover logic.
 * The evaluate function detects when fast EMA crosses above or below slow EMA.
 */
function makeEmaCrossoverFactory(
  riskCfg: RiskConfig,
  pmCfg: PositionManagerConfig,
  fastPeriod = 5,
  slowPeriod = 10,
): StrategyFactory {
  return (_params, deps) => {
    // Closure state for crossover detection (per-symbol)
    const prevFastMap = new Map<string, number>();
    const prevSlowMap = new Map<string, number>();

    const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
      const fast = indicators.fast;
      const slow = indicators.slow;
      if (fast === undefined || slow === undefined) return null;

      const prevFast = prevFastMap.get(symbol) ?? null;
      const prevSlow = prevSlowMap.get(symbol) ?? null;

      // Store current values for next iteration
      prevFastMap.set(symbol, fast);
      prevSlowMap.set(symbol, slow);

      // Need previous values to detect crossover
      if (prevFast === null || prevSlow === null) return null;

      // Bullish crossover: fast crosses above slow
      if (prevFast <= prevSlow && fast > slow) {
        return {
          action: 'ENTER_LONG',
          confidence: 0.9,
          price: candle.close,
          metadata: { fast, slow, crossover: 'bullish' },
        };
      }

      // Bearish crossover: fast crosses below slow
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
    const positionManager = new PositionManager(
      deps.bus,
      deps.executor,
      riskManager,
      pmCfg,
    );

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

/**
 * Variant strategy factory for monotonically trending data.
 * Enters LONG when fast EMA first appears above slow EMA (initial divergence),
 * in addition to standard crossover detection. This ensures at least one trade
 * on steadily trending fixture data.
 */
function makeEmaWithInitialEntryFactory(
  riskCfg: RiskConfig,
  pmCfg: PositionManagerConfig,
  fastPeriod = 5,
  slowPeriod = 10,
): StrategyFactory {
  return (_params, deps) => {
    const prevFastMap = new Map<string, number>();
    const prevSlowMap = new Map<string, number>();
    const hasEnteredMap = new Map<string, boolean>();

    const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
      const fast = indicators.fast;
      const slow = indicators.slow;
      if (fast === undefined || slow === undefined) return null;

      const prevFast = prevFastMap.get(symbol) ?? null;
      const prevSlow = prevSlowMap.get(symbol) ?? null;
      const hasEntered = hasEnteredMap.get(symbol) ?? false;

      prevFastMap.set(symbol, fast);
      prevSlowMap.set(symbol, slow);

      // On the first candle where both EMAs are valid, treat fast > slow as entry
      if (prevFast === null || prevSlow === null) {
        if (fast > slow && !hasEntered) {
          hasEnteredMap.set(symbol, true);
          return {
            action: 'ENTER_LONG',
            confidence: 0.8,
            price: candle.close,
            metadata: { fast, slow, reason: 'initial-divergence' },
          };
        }
        return null;
      }

      // Standard crossover detection
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

    const scannerFactory = createScannerFactory('ema-initial', evaluate);
    const scanner = scannerFactory(deps.bus, {
      symbols: [BTCUSDT],
      timeframe: '1m',
      indicators: {
        fast: () => createEMA({ period: fastPeriod }),
        slow: () => createEMA({ period: slowPeriod }),
      },
    });

    const riskManager = new RiskManager(deps.bus, riskCfg);
    const positionManager = new PositionManager(
      deps.bus,
      deps.executor,
      riskManager,
      pmCfg,
    );

    return new Strategy(
      {
        name: 'ema-initial-entry',
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

  test('produces exactly 2 deterministic trades', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    // ── Pin exact trade count ──
    expect(result.trades.length).toBe(2);
  });

  test('trade 0 is SHORT, closed by TAKE_PROFIT', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    const t0 = result.trades[0]!;
    expect(t0.side).toBe('SHORT');
    expect(t0.exitReason).toBe('TAKE_PROFIT');
    expect(t0.entryPrice).toBe(170);
    // TP for short at 5% SL/10% TP: takeProfitPrice = entry * (1 - 10/100) = 153
    expect(t0.exitPrice).toBe(153);
    expect(t0.pnl).toBeGreaterThan(0);
  });

  test('trade 1 is LONG, closed by TAKE_PROFIT', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    const t1 = result.trades[1]!;
    expect(t1.side).toBe('LONG');
    expect(t1.exitReason).toBe('TAKE_PROFIT');
    expect(t1.entryPrice).toBe(155);
    // TP for long at 10%: takeProfitPrice = entry * (1 + 10/100) = 170.5
    expect(t1.exitPrice).toBe(170.5);
    expect(t1.pnl).toBeGreaterThan(0);
  });

  test('all trades have non-zero fees', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    for (const trade of result.trades) {
      expect(trade.fees).toBeGreaterThan(0);
    }
  });

  test('all trades have pnl !== 0', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    for (const trade of result.trades) {
      expect(trade.pnl).not.toBe(0);
    }
  });

  test('finalBalance reflects profit from winning trades', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    expect(result.finalBalance).not.toBe(10_000);
    // Both trades are winners, so balance should increase
    expect(result.finalBalance).toBeGreaterThan(10_000);
  });

  test('metrics match trades', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    expect(result.metrics.totalTrades).toBe(2);
    expect(result.metrics.totalTrades).toBe(result.trades.length);
    // Both trades are winners
    expect(result.metrics.winRate).toBe(1);
  });

  test('pinned finalBalance value', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    // Pin the exact final balance for regression detection.
    // balance = 10_000 + pnl_trade0 + pnl_trade1
    // (accounting for fees applied by the sim exchange)
    expect(result.finalBalance).toBeCloseTo(10_199.384, 2);
  });

  test('each trade has valid exit reason and side', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    const validExitReasons = new Set([
      'STOP_LOSS',
      'TAKE_PROFIT',
      'TRAILING_STOP',
      'SIGNAL',
      'TIMEOUT',
      'FORCED',
    ]);
    for (const trade of result.trades) {
      expect(validExitReasons.has(trade.exitReason)).toBe(true);
      expect(['LONG', 'SHORT']).toContain(trade.side);
    }
  });
});

// =====================================================================
// Test Suite 2: Full Pipeline Integration
// =====================================================================

describe('E2E Full Pipeline Integration', () => {
  const fixtureCandles = fixtures.candles;

  const btConfig: BacktestConfig = {
    startTime: fixtureCandles[0]!.openTime,
    endTime: fixtureCandles[fixtureCandles.length - 1]!.closeTime + 1,
    symbols: [BTCUSDT],
    timeframes: ['1m'],
  };

  const fixtureRiskConfig: RiskConfig = {
    maxPositionSizePct: 10,
    maxConcurrentPositions: 1,
    maxDailyLossPct: 50,
    maxDrawdownPct: 50,
    maxDailyTrades: 100,
    cooldownAfterLossMs: 0,
    leverage: 1,
    initialBalance: 10_000,
  };

  // Fixture prices span ~50020..~51010 (~2% range over 100 candles).
  // Use tight TP (1%) so price movement is enough to close positions.
  const fixturePmConfig: PositionManagerConfig = {
    defaultStopLossPct: 5,
    defaultTakeProfitPct: 1,
    trailingStopEnabled: false,
    trailingStopActivationPct: 0,
    trailingStopDistancePct: 0,
    maxHoldTimeMs: 999_999_999,
  };

  const loader = async () => fixtureCandles;

  // The fixture data (100 candles, monotonically increasing from ~50020 to ~51010)
  // never has a price reversal, so a pure crossover strategy won't generate trades.
  // Use the variant that also enters on initial EMA divergence.
  const factory = makeEmaWithInitialEntryFactory(
    fixtureRiskConfig,
    fixturePmConfig,
    5,
    10,
  );

  test('pipeline produces at least 1 trade', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    // Fixture prices trend upward; the initial divergence entry should
    // produce at least one LONG that closes via TAKE_PROFIT.
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
  });

  test('all trades have valid fields (non-NaN pnl, positive fees, valid exit reasons)', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    for (const trade of result.trades) {
      expect(Number.isNaN(trade.pnl)).toBe(false);
      expect(trade.fees).toBeGreaterThan(0);
      expect([
        'STOP_LOSS',
        'TAKE_PROFIT',
        'TRAILING_STOP',
        'SIGNAL',
        'TIMEOUT',
        'FORCED',
      ]).toContain(trade.exitReason);
      expect(trade.entryPrice).toBeGreaterThan(0);
      expect(trade.exitPrice).toBeGreaterThan(0);
      expect(trade.quantity).toBeGreaterThan(0);
      expect(trade.holdTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('result.metrics has non-zero totalTrades', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    expect(result.metrics.totalTrades).toBeGreaterThan(0);
    expect(result.metrics.totalTrades).toBe(result.trades.length);
  });

  test('result.finalBalance != result.initialBalance', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const result = await engine.run(factory, {}, btConfig);

    expect(result.finalBalance).not.toBe(result.initialBalance);
  });

  test('no errors thrown during execution', async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    // Should complete without throwing
    const result = await engine.run(factory, {}, btConfig);
    expect(result).toBeDefined();
    expect(result.trades).toBeInstanceOf(Array);
    expect(result.metrics).toBeDefined();

    // Verify no NaN values leaked into metrics
    expect(Number.isNaN(result.metrics.winRate)).toBe(false);
    expect(Number.isNaN(result.metrics.profitFactor)).toBe(false);
    expect(Number.isNaN(result.metrics.expectancy)).toBe(false);
    expect(Number.isNaN(result.metrics.sharpeRatio)).toBe(false);
  });
});
