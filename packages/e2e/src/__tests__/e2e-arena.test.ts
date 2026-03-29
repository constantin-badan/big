import { describe, test, expect } from 'bun:test';

import { BacktestSimExchange } from '@trading-bot/backtest-engine';
import { EventBus } from '@trading-bot/event-bus';
import { BacktestExecutor } from '@trading-bot/order-executor';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  Candle,
  IEventBus,
  IStrategy,
  PositionManagerConfig,
  RiskConfig,
  ScannerEvaluate,
  StrategyFactory,
  TradeRecord,
  TradingEventMap,
  Timeframe,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

// ─── Constants ──────────────────────────────────────────────────────

const BASE_TIME = 1_700_000_000_000;
const BTCUSDT = toSymbol('BTCUSDT');
const TF_1M: Timeframe = '1m';
const CANDLE_MS = 60_000; // 1-minute candles

// ─── Candle Generation ──────────────────────────────────────────────

/**
 * Builds candles with configurable price ranges:
 *   - Phase 1 (0-9):   price ramps up to `peak`
 *   - Phase 2 (10-14):  price drops to `trough`
 *   - Phase 3 (15-19):  price recovers to `recovery`
 *
 * This creates multiple crossover opportunities for threshold-based scanners.
 */
function makeArenaCandles(
  count: number,
  startPrice: number,
  endPrice: number,
): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const close = startPrice + (endPrice - startPrice) * t;
    const open = close - 0.5;
    const high = close + 1;
    const low = close - 1;

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
      trades: 50,
      isClosed: true,
    });
  }
  return candles;
}

// ─── Threshold Scanner Strategy Factory ─────────────────────────────

/**
 * Creates a strategy that uses a simple threshold scanner:
 *   - ENTER_LONG when close > params.enterThreshold
 *   - EXIT (triggers SL/TP mechanism) when close < params.exitThreshold
 *
 * Uses a "fast" indicator (EMA period=2) just to get through the warmup,
 * but decisions are purely threshold-based on candle.close. This means
 * different params produce different trade behavior, enabling arena comparison.
 */
function makeThresholdStrategyFactory(
  riskConfig: RiskConfig,
  pmConfig: PositionManagerConfig,
): StrategyFactory {
  return (params, deps) => {
    const enterThreshold = params.enterThreshold ?? 100;
    const _exitThreshold = params.exitThreshold ?? 50;

    // Track whether we've emitted an entry signal (to avoid re-entering)
    let enteredOnce = false;

    const evaluate: ScannerEvaluate = (_indicators, candle, _symbol) => {
      // Simple threshold logic — no indicator values needed
      if (!enteredOnce && candle.close > enterThreshold) {
        enteredOnce = true;
        return {
          action: 'ENTER_LONG',
          confidence: 0.9,
          price: candle.close,
          metadata: { enterThreshold, trigger: 'above_threshold' },
        };
      }

      return null;
    };

    const scannerFactory = createScannerFactory(
      `threshold-${enterThreshold}`,
      evaluate,
    );
    const scanner = scannerFactory(deps.bus, {
      symbols: [BTCUSDT],
      timeframe: '1m',
      indicators: {
        // Dummy indicator just to satisfy warmup — result ignored in evaluate
        dummy: () => ({
          name: 'const',
          warmupPeriod: 1,
          config: {},
          update: () => 1,
          reset: () => {},
        }),
      },
    });

    const riskManager = new RiskManager(deps.bus, riskConfig);
    const positionManager = new PositionManager(
      deps.bus,
      deps.executor,
      riskManager,
      pmConfig,
    );

    return new Strategy(
      {
        name: `threshold-strategy-${enterThreshold}`,
        symbols: [BTCUSDT],
        scanners: [scanner],
        signalMerge: passthroughMerge,
        signalBufferWindowMs: CANDLE_MS,
        positionManager,
        riskManager,
      },
      deps,
    );
  };
}

// ─── Arena Instance Helper ──────────────────────────────────────────

/**
 * Creates an isolated arena instance with its own bus, sim exchange,
 * executor, and strategy. Returns controls for pumping candles and
 * inspecting trade results. Follows the same pattern as the existing
 * arena.test.ts createArenaInstance helper.
 */
function createArenaInstance(
  sourceBus: IEventBus,
  factory: StrategyFactory,
  params: Record<string, number>,
): {
  bus: IEventBus;
  strategy: IStrategy;
  trades: TradeRecord[];
  sim: BacktestSimExchange;
} {
  const bus = new EventBus();

  const sim = new BacktestSimExchange(bus, {
    feeStructure: { maker: 0.0002, taker: 0.0004 },
    slippageModel: { type: 'fixed', fixedBps: 0 },
    initialBalance: 10_000,
    leverage: 1,
  });

  const executor = new BacktestExecutor(bus, sim);

  const trades: TradeRecord[] = [];
  bus.on('position:closed', (data: TradingEventMap['position:closed']) => {
    trades.push(data.trade);
  });

  // Forward events from source bus to instance bus (same as Arena internals)
  sourceBus.on('candle:close', (data) => {
    bus.emit('candle:close', data);
  });
  sourceBus.on('candle:update', (data) => {
    bus.emit('candle:update', data);
  });
  sourceBus.on('tick', (data) => {
    bus.emit('tick', data);
  });

  const strategy = factory(params, { bus, exchange: sim, executor });

  return { bus, strategy, trades, sim };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('E2E Arena Pipeline', () => {
  const riskConfig: RiskConfig = {
    initialBalance: 10_000,
    maxDailyLossPct: 50,
    maxDrawdownPct: 50,
    maxDailyTrades: 100,
    maxConcurrentPositions: 3,
    cooldownAfterLossMs: 0,
    leverage: 1,
    maxPositionSizePct: 10,
  };

  const pmConfig: PositionManagerConfig = {
    defaultStopLossPct: 3,
    defaultTakeProfitPct: 5,
    trailingStopEnabled: false,
    trailingStopActivationPct: 0,
    trailingStopDistancePct: 0,
    maxHoldTimeMs: 999_999_999,
  };

  // Three different parameter sets with different entry thresholds.
  // With price ramping from 90 to 130:
  //   - Instance A (threshold=95):  enters early, more price to move
  //   - Instance B (threshold=110): enters mid-way
  //   - Instance C (threshold=125): enters late, near the top
  const paramSets = [
    { enterThreshold: 95, exitThreshold: 80 },
    { enterThreshold: 110, exitThreshold: 80 },
    { enterThreshold: 125, exitThreshold: 80 },
  ];

  test('all instances receive candles and produce independent trades', async () => {
    const sourceBus = new EventBus();
    const factory = makeThresholdStrategyFactory(riskConfig, pmConfig);

    // Create 3 arena instances with different thresholds
    const instances = paramSets.map((params) =>
      createArenaInstance(sourceBus, factory, params),
    );

    // Start all strategies
    for (const inst of instances) {
      await inst.strategy.start();
    }

    // Build candle sequence: ramp 90 -> 130, then drop to 90
    // This ensures entries at various thresholds, then SL/TP triggers on the drop
    const upCandles = makeArenaCandles(20, 90, 130);
    const downCandles: Candle[] = [];
    for (let i = 0; i < 15; i++) {
      const close = 130 - (i / 14) * 40; // 130 -> 90
      downCandles.push({
        symbol: BTCUSDT,
        openTime: BASE_TIME + (20 + i) * CANDLE_MS,
        closeTime: BASE_TIME + (21 + i) * CANDLE_MS - 1,
        open: close + 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
        quoteVolume: 1000 * close,
        trades: 50,
        isClosed: true,
      });
    }
    const allCandles = [...upCandles, ...downCandles];

    // Pump all candles through the source bus
    for (const candle of allCandles) {
      sourceBus.emit('candle:close', {
        symbol: BTCUSDT,
        timeframe: TF_1M,
        candle,
      });
    }

    // Stop all strategies
    for (const inst of instances) {
      await inst.strategy.stop();
      inst.sim.dispose();
    }

    console.log('=== ARENA INSTANCE RESULTS ===');
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]!;
      const p = paramSets[i]!;
      console.log(
        `  Instance ${i} (threshold=${p.enterThreshold}): ${inst.trades.length} trades`,
      );
      for (const t of inst.trades) {
        console.log(
          `    entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} pnl=${t.pnl.toFixed(4)} reason=${t.exitReason}`,
        );
      }
    }

    // Each instance should have received candles and attempted trades
    // Instance A (threshold=95) should enter earliest
    const instA = instances[0]!;
    expect(instA.trades.length).toBeGreaterThanOrEqual(1);

    // Instance B (threshold=110) should also enter
    const instB = instances[1]!;
    expect(instB.trades.length).toBeGreaterThanOrEqual(1);

    // All instances with trades should have different entry prices
    // (proving they entered at different thresholds, not identical times)
    const allEntryPrices = instances
      .filter((inst) => inst.trades.length > 0)
      .map((inst) => inst.trades[0]!.entryPrice);

    if (allEntryPrices.length >= 2) {
      // At least two instances should have different entry prices
      const uniquePrices = new Set(allEntryPrices.map((p) => p.toFixed(2)));
      expect(uniquePrices.size).toBeGreaterThanOrEqual(2);
    }
  });

  test('instance isolation — one instance trades do not leak to another', async () => {
    const sourceBus = new EventBus();
    const factory = makeThresholdStrategyFactory(riskConfig, pmConfig);

    // Instance A: low threshold (will trade)
    const instA = createArenaInstance(sourceBus, factory, {
      enterThreshold: 95,
      exitThreshold: 80,
    });

    // Instance B: impossibly high threshold (will never trade)
    const instB = createArenaInstance(sourceBus, factory, {
      enterThreshold: 999,
      exitThreshold: 80,
    });

    await instA.strategy.start();
    await instB.strategy.start();

    // Price ramps from 90 to 130 then drops back
    const upCandles = makeArenaCandles(20, 90, 130);
    const downCandles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      const close = 130 - (i / 9) * 45;
      downCandles.push({
        symbol: BTCUSDT,
        openTime: BASE_TIME + (20 + i) * CANDLE_MS,
        closeTime: BASE_TIME + (21 + i) * CANDLE_MS - 1,
        open: close + 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
        quoteVolume: 1000 * close,
        trades: 50,
        isClosed: true,
      });
    }

    for (const candle of [...upCandles, ...downCandles]) {
      sourceBus.emit('candle:close', {
        symbol: BTCUSDT,
        timeframe: TF_1M,
        candle,
      });
    }

    await instA.strategy.stop();
    await instB.strategy.stop();
    instA.sim.dispose();
    instB.sim.dispose();

    // Instance A should have trades, instance B should have none
    expect(instA.trades.length).toBeGreaterThan(0);
    expect(instB.trades.length).toBe(0);

    // Verify no shared TradeRecord objects between arrays
    // (They shouldn't share any references even if both had trades)
    for (const tradeA of instA.trades) {
      for (const tradeB of instB.trades) {
        expect(tradeA).not.toBe(tradeB);
      }
    }
  });

  test('order:filled events stay on their own bus', async () => {
    const sourceBus = new EventBus();
    const factory = makeThresholdStrategyFactory(riskConfig, pmConfig);

    const instA = createArenaInstance(sourceBus, factory, {
      enterThreshold: 95,
      exitThreshold: 80,
    });
    const instB = createArenaInstance(sourceBus, factory, {
      enterThreshold: 999,
      exitThreshold: 80,
    });

    let fillsOnBusA = 0;
    let fillsOnBusB = 0;

    instA.bus.on('order:filled', () => {
      fillsOnBusA += 1;
    });
    instB.bus.on('order:filled', () => {
      fillsOnBusB += 1;
    });

    await instA.strategy.start();
    await instB.strategy.start();

    // Ramp price up and down to trigger trades on instance A
    const upCandles = makeArenaCandles(20, 90, 130);
    const downCandles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      const close = 130 - (i / 9) * 45;
      downCandles.push({
        symbol: BTCUSDT,
        openTime: BASE_TIME + (20 + i) * CANDLE_MS,
        closeTime: BASE_TIME + (21 + i) * CANDLE_MS - 1,
        open: close + 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
        quoteVolume: 1000 * close,
        trades: 50,
        isClosed: true,
      });
    }

    for (const candle of [...upCandles, ...downCandles]) {
      sourceBus.emit('candle:close', {
        symbol: BTCUSDT,
        timeframe: TF_1M,
        candle,
      });
    }

    await instA.strategy.stop();
    await instB.strategy.stop();
    instA.sim.dispose();
    instB.sim.dispose();

    // Instance A should have received fills (from its own trades)
    expect(fillsOnBusA).toBeGreaterThan(0);

    // Instance B should have received NO fills (it never traded)
    expect(fillsOnBusB).toBe(0);
  });

  test('different param sets produce different rankings', async () => {
    const sourceBus = new EventBus();
    const factory = makeThresholdStrategyFactory(riskConfig, pmConfig);

    // Create two instances with very different thresholds
    const instances = [
      createArenaInstance(sourceBus, factory, { enterThreshold: 95, exitThreshold: 80 }),
      createArenaInstance(sourceBus, factory, { enterThreshold: 115, exitThreshold: 80 }),
    ];

    for (const inst of instances) {
      await inst.strategy.start();
    }

    // Price ramps up then drops — creates winning then losing conditions
    const upCandles = makeArenaCandles(20, 90, 130);
    const downCandles: Candle[] = [];
    for (let i = 0; i < 15; i++) {
      const close = 130 - (i / 14) * 40;
      downCandles.push({
        symbol: BTCUSDT,
        openTime: BASE_TIME + (20 + i) * CANDLE_MS,
        closeTime: BASE_TIME + (21 + i) * CANDLE_MS - 1,
        open: close + 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1000,
        quoteVolume: 1000 * close,
        trades: 50,
        isClosed: true,
      });
    }

    for (const candle of [...upCandles, ...downCandles]) {
      sourceBus.emit('candle:close', {
        symbol: BTCUSDT,
        timeframe: TF_1M,
        candle,
      });
    }

    for (const inst of instances) {
      await inst.strategy.stop();
      inst.sim.dispose();
    }

    // Both instances should have at least 1 trade
    expect(instances[0]!.trades.length).toBeGreaterThanOrEqual(1);
    expect(instances[1]!.trades.length).toBeGreaterThanOrEqual(1);

    // The two instances should have different entry prices and exit reasons,
    // proving they behave independently despite receiving the same candle stream.
    const entry0 = instances[0]!.trades[0]!.entryPrice;
    const entry1 = instances[1]!.trades[0]!.entryPrice;

    // Different thresholds -> different entry candles -> different entry prices
    expect(entry0).not.toBeCloseTo(entry1, 0);

    // Verify the exit reasons or exit prices differ, confirming independent position tracking
    const exit0 = instances[0]!.trades[0]!.exitPrice;
    const exit1 = instances[1]!.trades[0]!.exitPrice;
    expect(exit0).not.toBeCloseTo(exit1, 0);

    console.log('=== RANKING RESULTS ===');
    console.log(
      `Instance 0 (threshold=95): entry=${entry0.toFixed(2)} exit=${exit0.toFixed(2)}, trades=${instances[0]!.trades.length}`,
    );
    console.log(
      `Instance 1 (threshold=115): entry=${entry1.toFixed(2)} exit=${exit1.toFixed(2)}, trades=${instances[1]!.trades.length}`,
    );
  });

  test('three instances all receive same number of candle events', async () => {
    const sourceBus = new EventBus();

    const candleCounts = [0, 0, 0];

    // Simple counting factory — just counts candle:close events
    const countingFactory: StrategyFactory = (params, deps) => {
      const idx = params.idx ?? 0;
      const handler = (_data: TradingEventMap['candle:close']): void => {
        candleCounts[idx]! += 1;
      };

      deps.bus.on('candle:close', handler);

      return {
        name: `counter-${idx}`,
        start: () => Promise.resolve(),
        stop: () => {
          deps.bus.off('candle:close', handler);
          return Promise.resolve();
        },
        getStats: () => ({
          totalTrades: 0,
          winRate: 0,
          profitFactor: 0,
          sharpeRatio: 0,
          maxDrawdown: 0,
          maxDrawdownDuration: 0,
          avgWin: 0,
          avgLoss: 0,
          expectancy: 0,
          avgHoldTime: 0,
          totalFees: 0,
          totalSlippage: 0,
        }),
      };
    };

    const instances = [
      createArenaInstance(sourceBus, countingFactory, { idx: 0 }),
      createArenaInstance(sourceBus, countingFactory, { idx: 1 }),
      createArenaInstance(sourceBus, countingFactory, { idx: 2 }),
    ];

    for (const inst of instances) {
      await inst.strategy.start();
    }

    const candles = makeArenaCandles(25, 100, 150);
    for (const candle of candles) {
      sourceBus.emit('candle:close', {
        symbol: BTCUSDT,
        timeframe: TF_1M,
        candle,
      });
    }

    for (const inst of instances) {
      await inst.strategy.stop();
      inst.sim.dispose();
    }

    // All 3 instances should have received all 25 candles
    expect(candleCounts[0]).toBe(25);
    expect(candleCounts[1]).toBe(25);
    expect(candleCounts[2]).toBe(25);
  });
});
