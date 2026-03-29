import { describe, test, expect } from 'bun:test';

import { BacktestSimExchange } from '@trading-bot/backtest-engine';
import { EventBus } from '@trading-bot/event-bus';
import { BacktestExecutor } from '@trading-bot/order-executor';
import type { IStrategy, StrategyFactory } from '@trading-bot/types';
import { fixtures } from '@trading-bot/test-utils';
import type { Candle, ExchangeConfig, IEventBus, PerformanceMetrics, TradingEventMap, TradeRecord } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { Arena } from '../arena';
import type { ArenaConfig } from '../types';

const BASE_TIME = 1700000000000;

const zeroMetrics: PerformanceMetrics = {
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
};

const simConfig: ExchangeConfig = {
  type: 'backtest-sim',
  feeStructure: { maker: 0.0002, taker: 0.0004 },
  slippageModel: { type: 'fixed', fixedBps: 0 },
  initialBalance: 10_000,
};

function makeClosedCandle(index: number): Candle {
  const open = 50_000 + index * 100;
  return {
    symbol: toSymbol('BTCUSDT'),
    openTime: BASE_TIME + index * 60_000,
    closeTime: BASE_TIME + (index + 1) * 60_000 - 1,
    open,
    high: open + 50,
    low: open - 30,
    close: open + 20,
    volume: 100,
    quoteVolume: 5_000_000,
    trades: 50,
    isClosed: true,
  };
}

function buildArenaConfig(
  factory: StrategyFactory,
  paramSets: Record<string, number>[],
): ArenaConfig {
  return {
    exchangeConfig: {
      type: 'binance-testnet',
      apiKey: 'test-key',
      privateKey: 'test-secret',
    },
    simExchangeConfig: simConfig,
    symbols: [toSymbol('BTCUSDT')],
    timeframes: ['1m'],
    factory,
    paramSets,
    evaluationWindowMs: 3_600_000,
  };
}

// Minimal strategy factory that counts candle:close events per param key
function countingFactory(): {
  factory: StrategyFactory;
  getCounts: () => Map<string, number>;
} {
  const counts = new Map<string, number>();

  const factory: StrategyFactory = (params, deps) => {
    const key = `threshold=${params['threshold'] ?? 0}`;
    counts.set(key, 0);

    const handler = (_data: TradingEventMap['candle:close']): void => {
      const current = counts.get(key) ?? 0;
      counts.set(key, current + 1);
    };

    deps.bus.on('candle:close', handler);

    const strategy: IStrategy = {
      name: `counter-${key}`,
      start: () => Promise.resolve(),
      stop: () => {
        deps.bus.off('candle:close', handler);
        return Promise.resolve();
      },
      getStats: () => zeroMetrics,
    };
    return strategy;
  };

  return { factory, getCounts: () => counts };
}

// Trading factory: buys at candle N, sells at candle M, emits position:closed
function tradingFactory(buyAt: number, sellAt: number): StrategyFactory {
  return (_params, deps) => {
    let count = 0;
    let entryPrice = 0;
    let entryTime = 0;

    const handler = (data: TradingEventMap['candle:close']): void => {
      count += 1;

      if (count === buyAt) {
        deps.executor.submit({
          symbol: data.symbol,
          side: 'BUY',
          type: 'MARKET',
          quantity: 0.1,
        });
        entryPrice = data.candle.close;
        entryTime = data.candle.closeTime;
      }

      if (count === sellAt && entryPrice > 0) {
        deps.executor.submit({
          symbol: data.symbol,
          side: 'SELL',
          type: 'MARKET',
          quantity: 0.1,
        });

        const exitPrice = data.candle.close;
        const pnl = (exitPrice - entryPrice) * 0.1;
        const trade: TradeRecord = {
          id: `trade-${count}`,
          symbol: data.symbol,
          side: 'LONG',
          entryPrice,
          exitPrice,
          quantity: 0.1,
          entryTime,
          exitTime: data.candle.closeTime,
          pnl,
          fees: 0.1 * entryPrice * 0.0004 + 0.1 * exitPrice * 0.0004,
          slippage: 0,
          holdTimeMs: data.candle.closeTime - entryTime,
          exitReason: 'SIGNAL',
          metadata: {},
        };
        deps.bus.emit('position:closed', {
          position: {
            symbol: data.symbol,
            side: 'LONG',
            entryPrice,
            quantity: 0.1,
            unrealizedPnl: 0,
            leverage: 1,
            liquidationPrice: 0,
            marginType: 'ISOLATED',
            timestamp: entryTime,
          },
          trade,
        });
        entryPrice = 0;
      }
    };

    deps.bus.on('candle:close', handler);

    const strategy: IStrategy = {
      name: 'test-trader',
      start: () => Promise.resolve(),
      stop: () => {
        deps.bus.off('candle:close', handler);
        return Promise.resolve();
      },
      getStats: () => zeroMetrics,
    };
    return strategy;
  };
}

// Helper: create an isolated arena instance with its own bus, sim, executor
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
    leverage: 125,
  });

  const executor = new BacktestExecutor(bus, sim);

  const trades: TradeRecord[] = [];
  bus.on('position:closed', (data) => {
    trades.push(data.trade);
  });

  // Forward events from source bus to this instance bus
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

// ──────────────────────────────────────────────
// Arena constructor tests
// ──────────────────────────────────────────────

describe('Arena', () => {
  test('rejects non-backtest-sim simExchangeConfig', () => {
    expect(() => {
      new Arena({
        exchangeConfig: {
          type: 'binance-testnet',
          apiKey: 'key',
          privateKey: 'secret',
        },
        simExchangeConfig: {
          type: 'binance-live',
          apiKey: 'key',
          privateKey: 'secret',
        },
        symbols: [toSymbol('BTCUSDT')],
        timeframes: ['1m'],
        factory: () => ({
          name: 'x',
          start: () => Promise.resolve(),
          stop: () => Promise.resolve(),
          getStats: () => zeroMetrics,
        }),
        paramSets: [],
        evaluationWindowMs: 3_600_000,
      });
    }).toThrow("simExchangeConfig must be 'backtest-sim'");
  });

  test('getRankings returns empty when no instances', () => {
    const { factory } = countingFactory();
    const config = buildArenaConfig(factory, []);
    const arena = new Arena(config);
    expect(arena.getRankings()).toEqual([]);
  });

  test('constructor accepts valid backtest-sim config', () => {
    const { factory } = countingFactory();
    const config = buildArenaConfig(factory, [{ threshold: 10 }]);
    const arena = new Arena(config);
    expect(arena).toBeDefined();
  });
});

// ──────────────────────────────────────────────
// Event forwarding integration tests
// ──────────────────────────────────────────────

describe('Arena event forwarding', () => {
  test('candle:close events broadcast to all strategy instances', async () => {
    const { factory, getCounts } = countingFactory();
    const sourceBus = new EventBus();

    const instances = [
      createArenaInstance(sourceBus, factory, { threshold: 10 }),
      createArenaInstance(sourceBus, factory, { threshold: 20 }),
      createArenaInstance(sourceBus, factory, { threshold: 30 }),
    ];

    for (const inst of instances) {
      await inst.strategy.start();
    }

    // Simulate 5 candle arrivals on the source bus
    for (let i = 0; i < 5; i++) {
      sourceBus.emit('candle:close', {
        symbol: toSymbol('BTCUSDT'),
        timeframe: '1m',
        candle: makeClosedCandle(i),
      });
    }

    // Each instance should have received all 5 candles
    const counts = getCounts();
    expect(counts.get('threshold=10')).toBe(5);
    expect(counts.get('threshold=20')).toBe(5);
    expect(counts.get('threshold=30')).toBe(5);

    for (const inst of instances) {
      await inst.strategy.stop();
      inst.sim.dispose();
    }
  });

  test('instances are isolated — trades on one bus do not affect another', async () => {
    const sourceBus = new EventBus();

    // Instance A: trades on candle 2/4
    const instA = createArenaInstance(sourceBus, tradingFactory(2, 4), {});

    // Instance B: never trades (buyAt=100 exceeds candle count)
    const instB = createArenaInstance(sourceBus, tradingFactory(100, 200), {});

    await instA.strategy.start();
    await instB.strategy.start();

    // Send 5 candles
    for (let i = 0; i < 5; i++) {
      sourceBus.emit('candle:close', {
        symbol: toSymbol('BTCUSDT'),
        timeframe: '1m',
        candle: makeClosedCandle(i),
      });
    }

    // Instance A should have 1 trade, instance B should have 0
    expect(instA.trades.length).toBe(1);
    expect(instA.trades[0]?.side).toBe('LONG');
    expect(instA.trades[0]?.pnl).toBeGreaterThan(0);
    expect(instB.trades.length).toBe(0);

    await instA.strategy.stop();
    await instB.strategy.stop();
    instA.sim.dispose();
    instB.sim.dispose();
  });

  test('tick events forwarded to instance buses', () => {
    const sourceBus = new EventBus();
    const instanceBus = new EventBus();

    sourceBus.on('tick', (data) => {
      instanceBus.emit('tick', data);
    });

    let receivedTick = false;
    instanceBus.on('tick', () => {
      receivedTick = true;
    });

    sourceBus.emit('tick', { symbol: toSymbol('BTCUSDT'), tick: fixtures.tick });
    expect(receivedTick).toBe(true);
  });

  test('candle:update events forwarded to instance buses', () => {
    const sourceBus = new EventBus();
    const instanceBus = new EventBus();

    sourceBus.on('candle:update', (data) => {
      instanceBus.emit('candle:update', data);
    });

    let received = false;
    instanceBus.on('candle:update', () => {
      received = true;
    });

    const updateCandle: Candle = { ...fixtures.candle, isClosed: false };
    sourceBus.emit('candle:update', {
      symbol: toSymbol('BTCUSDT'),
      timeframe: '1m',
      candle: updateCandle,
    });
    expect(received).toBe(true);
  });
});

// ──────────────────────────────────────────────
// SimExchange price tracking via forwarded events
// ──────────────────────────────────────────────

describe('SimExchange price tracking', () => {
  test('SimExchange on instance bus tracks price from forwarded candle:close', () => {
    const instanceBus = new EventBus();
    const sim = new BacktestSimExchange(instanceBus, {
      feeStructure: { maker: 0.0002, taker: 0.0004 },
      slippageModel: { type: 'fixed', fixedBps: 0 },
      initialBalance: 10_000,
      leverage: 125,
    });

    // Before any candle, MARKET order is rejected (no price data)
    const beforeResult = sim.simulateFill({
      symbol: toSymbol('BTCUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.001,
    });
    expect(beforeResult.status).toBe('REJECTED');

    // Forward a candle:close to the instance bus
    const candle = makeClosedCandle(0);
    instanceBus.emit('candle:close', {
      symbol: toSymbol('BTCUSDT'),
      timeframe: '1m',
      candle,
    });

    // Now MARKET order fills at candle's close price
    const afterResult = sim.simulateFill({
      symbol: toSymbol('BTCUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.001,
    });
    expect(afterResult.status).toBe('FILLED');
    expect(afterResult.avgPrice).toBe(candle.close);

    sim.dispose();
  });

  test('multiple symbols tracked independently', () => {
    const instanceBus = new EventBus();
    const sim = new BacktestSimExchange(instanceBus, {
      feeStructure: { maker: 0.0002, taker: 0.0004 },
      slippageModel: { type: 'fixed', fixedBps: 0 },
      initialBalance: 100_000,
      leverage: 125,
    });

    const btcCandle = makeClosedCandle(0);
    const ethCandle: Candle = {
      ...makeClosedCandle(0),
      close: 3_000,
    };

    instanceBus.emit('candle:close', {
      symbol: toSymbol('BTCUSDT'),
      timeframe: '1m',
      candle: btcCandle,
    });
    instanceBus.emit('candle:close', {
      symbol: toSymbol('ETHUSDT'),
      timeframe: '1m',
      candle: ethCandle,
    });

    const btcFill = sim.simulateFill({
      symbol: toSymbol('BTCUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.001,
    });
    expect(btcFill.avgPrice).toBe(btcCandle.close);

    const ethFill = sim.simulateFill({
      symbol: toSymbol('ETHUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.01,
    });
    expect(ethFill.avgPrice).toBe(ethCandle.close);

    sim.dispose();
  });
});

// ──────────────────────────────────────────────
// Dynamic instance management
// ──────────────────────────────────────────────

describe('Arena dynamic instances', () => {
  test('addInstance mid-run receives subsequent events', async () => {
    const { factory, getCounts } = countingFactory();
    const sourceBus = new EventBus();

    // Start with one instance
    const inst1 = createArenaInstance(sourceBus, factory, { threshold: 10 });
    await inst1.strategy.start();

    // Send 3 candles
    for (let i = 0; i < 3; i++) {
      sourceBus.emit('candle:close', {
        symbol: toSymbol('BTCUSDT'),
        timeframe: '1m',
        candle: makeClosedCandle(i),
      });
    }

    // Add second instance mid-run
    const inst2 = createArenaInstance(sourceBus, factory, { threshold: 20 });
    await inst2.strategy.start();

    // Send 2 more candles
    for (let i = 3; i < 5; i++) {
      sourceBus.emit('candle:close', {
        symbol: toSymbol('BTCUSDT'),
        timeframe: '1m',
        candle: makeClosedCandle(i),
      });
    }

    const counts = getCounts();
    expect(counts.get('threshold=10')).toBe(5); // all 5
    expect(counts.get('threshold=20')).toBe(2); // only last 2

    await inst1.strategy.stop();
    await inst2.strategy.stop();
    inst1.sim.dispose();
    inst2.sim.dispose();
  });

  test('order:filled events stay on their own bus', async () => {
    const sourceBus = new EventBus();

    const instA = createArenaInstance(sourceBus, tradingFactory(1, 3), {});
    await instA.strategy.start();

    let fillsOnBusB = 0;
    const instB = createArenaInstance(sourceBus, tradingFactory(100, 200), {});
    instB.bus.on('order:filled', () => {
      fillsOnBusB += 1;
    });
    await instB.strategy.start();

    // Send 5 candles — instance A trades, instance B doesn't
    for (let i = 0; i < 5; i++) {
      sourceBus.emit('candle:close', {
        symbol: toSymbol('BTCUSDT'),
        timeframe: '1m',
        candle: makeClosedCandle(i),
      });
    }

    expect(instA.trades.length).toBe(1);
    // order:filled from A's executor should NOT appear on B's bus
    expect(fillsOnBusB).toBe(0);

    await instA.strategy.stop();
    await instB.strategy.stop();
    instA.sim.dispose();
    instB.sim.dispose();
  });
});
