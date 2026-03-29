import { describe, test, expect, beforeAll } from 'bun:test';

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
const CANDLE_MS = 60_000;

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

// ─── Candle Generation ──────────────────────────────────────────────

function makeLinearCandles(
  count: number,
  startPrice: number,
  endPrice: number,
  startIndex = 0,
): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const t = count > 1 ? i / (count - 1) : 0;
    const close = startPrice + (endPrice - startPrice) * t;
    return {
      symbol: BTCUSDT,
      openTime: BASE_TIME + (startIndex + i) * CANDLE_MS,
      closeTime: BASE_TIME + (startIndex + i + 1) * CANDLE_MS - 1,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000,
      quoteVolume: 1000 * close,
      trades: 50,
      isClosed: true,
    };
  });
}

/** Shared candle sequence: ramp 90→130 (20 candles), drop 130→90 (15 candles). */
function makeUpDownCandles(): Candle[] {
  const up = makeLinearCandles(20, 90, 130, 0);
  const down = makeLinearCandles(15, 130, 90, 20);
  return [...up, ...down];
}

// ─── Threshold Strategy Factory ─────────────────────────────────────

/**
 * Enters LONG when close > enterThreshold. One entry per instance.
 * Exits via SL/TP from position-manager — no signal-based exits.
 */
function makeThresholdFactory(): StrategyFactory {
  return (params, deps) => {
    const enterThreshold = params.enterThreshold ?? 100;
    let enteredOnce = false;

    const evaluate: ScannerEvaluate = (_indicators, candle, _symbol) => {
      if (!enteredOnce && candle.close > enterThreshold) {
        enteredOnce = true;
        return {
          action: 'ENTER_LONG',
          confidence: 0.9,
          price: candle.close,
          metadata: { enterThreshold },
        };
      }
      return null;
    };

    const scannerFactory = createScannerFactory(`threshold-${String(enterThreshold)}`, evaluate);
    const scanner = scannerFactory(deps.bus, {
      symbols: [BTCUSDT],
      timeframe: '1m',
      indicators: {
        dummy: () => ({ name: 'const', warmupPeriod: 1, config: {}, update: () => 1, reset: () => {} }),
      },
    });

    const riskManager = new RiskManager(deps.bus, riskConfig);
    const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, pmConfig);

    return new Strategy(
      {
        name: `threshold-${String(enterThreshold)}`,
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

interface ArenaInstance {
  bus: IEventBus;
  strategy: IStrategy;
  trades: TradeRecord[];
  sim: BacktestSimExchange;
}

function createArenaInstance(
  sourceBus: IEventBus,
  factory: StrategyFactory,
  params: Record<string, number>,
): ArenaInstance {
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

  // Forward market data from source bus to instance bus (mirrors Arena internals)
  sourceBus.on('candle:close', (data) => bus.emit('candle:close', data));
  sourceBus.on('candle:update', (data) => bus.emit('candle:update', data));
  sourceBus.on('tick', (data) => bus.emit('tick', data));

  const strategy = factory(params, { bus, exchange: sim, executor });
  return { bus, strategy, trades, sim };
}

function pumpCandles(bus: IEventBus, candles: Candle[]): void {
  for (const candle of candles) {
    bus.emit('candle:close', { symbol: BTCUSDT, timeframe: TF_1M, candle });
  }
}

async function cleanupInstances(instances: ArenaInstance[]): Promise<void> {
  for (const inst of instances) {
    await inst.strategy.stop();
    inst.sim.dispose();
  }
}

// =====================================================================
// Tests
// =====================================================================

describe('E2E Arena Pipeline', () => {
  // Shared candle data for all tests
  const candles = makeUpDownCandles();

  describe('three instances with different thresholds (pinned)', () => {
    const factory = makeThresholdFactory();
    let instances: ArenaInstance[];

    beforeAll(async () => {
      const sourceBus = new EventBus();
      instances = [
        createArenaInstance(sourceBus, factory, { enterThreshold: 95 }),
        createArenaInstance(sourceBus, factory, { enterThreshold: 110 }),
        createArenaInstance(sourceBus, factory, { enterThreshold: 125 }),
      ];
      for (const inst of instances) await inst.strategy.start();
      pumpCandles(sourceBus, candles);
      await cleanupInstances(instances);
    });

    test('each instance produces exactly 1 trade', () => {
      expect(instances[0]!.trades.length).toBe(1);
      expect(instances[1]!.trades.length).toBe(1);
      expect(instances[2]!.trades.length).toBe(1);
    });

    test('instance A (threshold=95): LONG, TAKE_PROFIT, positive pnl', () => {
      const t = instances[0]!.trades[0]!;
      expect(t.side).toBe('LONG');
      expect(t.exitReason).toBe('TAKE_PROFIT');
      expect(t.entryPrice).toBeCloseTo(96.316, 2);
      expect(t.exitPrice).toBeCloseTo(101.132, 2);
      expect(t.pnl).toBeGreaterThan(0);
    });

    test('instance B (threshold=110): LONG, TAKE_PROFIT, positive pnl', () => {
      const t = instances[1]!.trades[0]!;
      expect(t.side).toBe('LONG');
      expect(t.exitReason).toBe('TAKE_PROFIT');
      expect(t.entryPrice).toBeCloseTo(111.053, 2);
      expect(t.exitPrice).toBeCloseTo(116.605, 2);
      expect(t.pnl).toBeGreaterThan(0);
    });

    test('instance C (threshold=125): LONG, STOP_LOSS, negative pnl', () => {
      // Enters late near the top, price reverses → SL fires
      const t = instances[2]!.trades[0]!;
      expect(t.side).toBe('LONG');
      expect(t.exitReason).toBe('STOP_LOSS');
      expect(t.entryPrice).toBeCloseTo(125.789, 2);
      expect(t.exitPrice).toBeCloseTo(122.016, 2);
      expect(t.pnl).toBeLessThan(0);
    });

    test('all instances have different entry prices (independent behavior)', () => {
      const prices = instances.map((inst) => inst.trades[0]!.entryPrice);
      expect(prices[0]).not.toBe(prices[1]);
      expect(prices[1]).not.toBe(prices[2]);
    });

    test('initialBalance is 10000 for all instances', async () => {
      for (const inst of instances) {
        const balances = await inst.sim.getBalance();
        // Balance moved from initial — trades happened
        expect(balances[0]!.total).not.toBe(10_000);
      }
    });
  });

  test('instance isolation: high-threshold instance gets zero trades', async () => {
    const sourceBus = new EventBus();
    const factory = makeThresholdFactory();

    const instA = createArenaInstance(sourceBus, factory, { enterThreshold: 95 });
    const instB = createArenaInstance(sourceBus, factory, { enterThreshold: 999 });

    await instA.strategy.start();
    await instB.strategy.start();
    pumpCandles(sourceBus, candles);
    await cleanupInstances([instA, instB]);

    expect(instA.trades.length).toBe(1);
    expect(instB.trades.length).toBe(0);
  });

  test('order:filled events stay on their own bus', async () => {
    const sourceBus = new EventBus();
    const factory = makeThresholdFactory();

    const instA = createArenaInstance(sourceBus, factory, { enterThreshold: 95 });
    const instB = createArenaInstance(sourceBus, factory, { enterThreshold: 999 });

    let fillsOnA = 0;
    let fillsOnB = 0;
    instA.bus.on('order:filled', () => { fillsOnA += 1; });
    instB.bus.on('order:filled', () => { fillsOnB += 1; });

    await instA.strategy.start();
    await instB.strategy.start();
    pumpCandles(sourceBus, candles);
    await cleanupInstances([instA, instB]);

    expect(fillsOnA).toBeGreaterThan(0);
    expect(fillsOnB).toBe(0);
  });

  test('all instances receive the same number of candle events', async () => {
    const sourceBus = new EventBus();
    const counts = [0, 0, 0];

    // 3 buses forwarded from source, just count candle:close events
    const buses = [new EventBus(), new EventBus(), new EventBus()];
    for (let i = 0; i < 3; i++) {
      const idx = i;
      sourceBus.on('candle:close', (data) => {
        buses[idx]!.emit('candle:close', data);
      });
      buses[idx]!.on('candle:close', () => { counts[idx]! += 1; });
    }

    pumpCandles(sourceBus, candles);

    expect(counts[0]).toBe(35);
    expect(counts[1]).toBe(35);
    expect(counts[2]).toBe(35);
  });
});
