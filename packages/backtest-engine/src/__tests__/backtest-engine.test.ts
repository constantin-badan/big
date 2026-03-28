import { describe, test, expect } from 'bun:test';

import { EventBus } from '@trading-bot/event-bus';
import type { IStrategy, StrategyFactory } from '@trading-bot/strategy';
import { fixtures } from '@trading-bot/test-utils';
import type {
  Candle,
  ExchangeConfig,
  BacktestConfig,
  TradeRecord,
  PerformanceMetrics,
  Timeframe,
} from '@trading-bot/types';

import { createBacktestEngine } from '../backtest-engine';
import { BacktestSimExchange } from '../backtest-sim-exchange';

const BASE_TIME = 1700000000000;

function makeCandles(count: number, basePrice: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: BASE_TIME + i * 60_000,
    closeTime: BASE_TIME + (i + 1) * 60_000 - 1,
    open: basePrice + i * 10,
    high: basePrice + i * 10 + 50,
    low: basePrice + i * 10 - 30,
    close: basePrice + i * 10 + 20,
    volume: 100,
    quoteVolume: 5_000_000,
    trades: 50,
    isClosed: true,
  }));
}

const simConfig: ExchangeConfig = {
  type: 'backtest-sim',
  feeStructure: { maker: 0.0002, taker: 0.0004 },
  slippageModel: { type: 'fixed', fixedBps: 5 },
  initialBalance: 10_000,
};

const btConfig: BacktestConfig = {
  startTime: BASE_TIME,
  endTime: BASE_TIME + 100 * 60_000,
  symbols: ['BTCUSDT'],
  timeframes: ['1m'],
};

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

function seedPrice(bus: EventBus, symbol: string, price: number): void {
  const tf: Timeframe = '1m';
  bus.emit('candle:close', {
    symbol,
    timeframe: tf,
    candle: { ...fixtures.candle, close: price },
  });
}

// Minimal strategy factory: buys at candle `buyAt`, sells at `sellAt`,
// and manually emits position:closed so the engine collects the trade.
function tradingFactory(buyAt: number, sellAt: number): StrategyFactory {
  return (_params, deps) => {
    let count = 0;
    let entryPrice = 0;
    let entryTime = 0;

    const handler = (data: { symbol: string; timeframe: Timeframe; candle: Candle }) => {
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
          id: 'trade-1',
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
      name: 'test-strategy',
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

// ──────────────────────────────────────────────
// BacktestSimExchange unit tests
// ──────────────────────────────────────────────

describe('BacktestSimExchange', () => {
  function createExchange(slippageBps = 5) {
    const bus = new EventBus();
    const exchange = new BacktestSimExchange(bus, {
      feeStructure: { maker: 0.0002, taker: 0.0004 },
      slippageModel: { type: 'fixed', fixedBps: slippageBps },
      initialBalance: 10_000,
      leverage: 125, // high leverage so margin check doesn't interfere with fill mechanics tests
    });
    seedPrice(bus, 'BTCUSDT', 50_000);
    return { bus, exchange };
  }

  test('MARKET BUY fills at current price + slippage', () => {
    const { exchange } = createExchange(10); // 10 bps
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 1,
    });
    expect(result.status).toBe('FILLED');
    // 50000 * (1 + 10/10000) = 50000 * 1.001 = 50050
    expect(result.avgPrice).toBeCloseTo(50_050, 2);
  });

  test('MARKET SELL fills at current price - slippage', () => {
    const { exchange } = createExchange(10);
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: 1,
    });
    expect(result.status).toBe('FILLED');
    // 50000 * (1 - 10/10000) = 50000 * 0.999 = 49950
    expect(result.avgPrice).toBeCloseTo(49_950, 2);
  });

  test('LIMIT BUY fills at limit price when market <= limit', () => {
    const { exchange } = createExchange();
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: 1,
      price: 51_000, // above current 50000 → fills
    });
    expect(result.status).toBe('FILLED');
    expect(result.avgPrice).toBe(51_000);
  });

  test('LIMIT BUY rejected when market > limit', () => {
    const { exchange } = createExchange();
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: 1,
      price: 49_000, // below current 50000 → rejected
    });
    expect(result.status).toBe('REJECTED');
  });

  test('LIMIT SELL fills at limit price when market >= limit', () => {
    const { exchange } = createExchange();
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'LIMIT',
      quantity: 1,
      price: 49_000, // below current 50000 → fills
    });
    expect(result.status).toBe('FILLED');
    expect(result.avgPrice).toBe(49_000);
  });

  test('LIMIT SELL rejected when market < limit', () => {
    const { exchange } = createExchange();
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'LIMIT',
      quantity: 1,
      price: 51_000, // above current 50000 → rejected
    });
    expect(result.status).toBe('REJECTED');
  });

  test('STOP_MARKET BUY triggers when price >= stopPrice', () => {
    const { exchange } = createExchange(10);
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_MARKET',
      quantity: 1,
      stopPrice: 49_000, // current 50000 >= 49000 → triggers
    });
    expect(result.status).toBe('FILLED');
    // Fills at stopPrice + slippage: 49000 * 1.001 = 49049
    expect(result.avgPrice).toBeCloseTo(49_049, 0);
  });

  test('STOP_MARKET BUY rejected when price < stopPrice', () => {
    const { exchange } = createExchange();
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'STOP_MARKET',
      quantity: 1,
      stopPrice: 51_000, // current 50000 < 51000 → not triggered
    });
    expect(result.status).toBe('REJECTED');
  });

  test('STOP_MARKET SELL triggers when price <= stopPrice', () => {
    const { exchange } = createExchange(10);
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_MARKET',
      quantity: 1,
      stopPrice: 51_000, // current 50000 <= 51000 → triggers
    });
    expect(result.status).toBe('FILLED');
    // Fills at stopPrice - slippage: 51000 * 0.999 = 50949
    expect(result.avgPrice).toBeCloseTo(50_949, 0);
  });

  test('TAKE_PROFIT_MARKET SELL triggers when price >= stopPrice', () => {
    const { exchange } = createExchange(10);
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      quantity: 1,
      stopPrice: 49_000, // current 50000 >= 49000 → triggers
    });
    expect(result.status).toBe('FILLED');
    // Fills at stopPrice - slippage: 49000 * 0.999 = 48951
    expect(result.avgPrice).toBeCloseTo(48_951, 0);
  });

  test('TAKE_PROFIT_MARKET BUY triggers when price <= stopPrice', () => {
    const { exchange } = createExchange(10);
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'TAKE_PROFIT_MARKET',
      quantity: 1,
      stopPrice: 51_000, // current 50000 <= 51000 → triggers
    });
    expect(result.status).toBe('FILLED');
    // Fills at stopPrice + slippage: 51000 * 1.001 = 51051
    expect(result.avgPrice).toBeCloseTo(51_051, 0);
  });

  test('fee is quantity * fillPrice * taker rate', () => {
    const { exchange } = createExchange(0); // zero slippage for easy math
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 2,
    });
    expect(result.status).toBe('FILLED');
    // fee = 2 * 50000 * 0.0004 = 40
    expect(result.commission).toBeCloseTo(40, 2);
  });

  test('rejects when no price data for symbol', () => {
    const { exchange } = createExchange();
    const result = exchange.simulateFill({
      symbol: 'ETHUSDT', // never received a candle
      side: 'BUY',
      type: 'MARKET',
      quantity: 1,
    });
    expect(result.status).toBe('REJECTED');
  });

  // Non-fixed slippage model is now rejected at compile time by the
  // discriminated union (SlippageModel & { type: 'fixed' }). Runtime guard
  // remains in BacktestSimExchange for extra safety.

  test('BUY rejected when margin is insufficient', () => {
    const bus = new EventBus();
    const exchange = new BacktestSimExchange(bus, {
      feeStructure: { maker: 0.0002, taker: 0.0004 },
      slippageModel: { type: 'fixed', fixedBps: 0 },
      initialBalance: 1_000,
      leverage: 1, // 1x leverage → full notional as margin
    });
    seedPrice(bus, 'BTCUSDT', 50_000);
    // Need 50_000 margin but only have 1_000
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 1,
    });
    expect(result.status).toBe('REJECTED');
  });

  test('BUY fills when leverage provides sufficient margin', () => {
    const bus = new EventBus();
    const exchange = new BacktestSimExchange(bus, {
      feeStructure: { maker: 0.0002, taker: 0.0004 },
      slippageModel: { type: 'fixed', fixedBps: 0 },
      initialBalance: 1_000,
      leverage: 100, // 100x → margin = 50_000/100 = 500 < 1_000
    });
    seedPrice(bus, 'BTCUSDT', 50_000);
    const result = exchange.simulateFill({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 1,
    });
    expect(result.status).toBe('FILLED');
  });

  test('dispose unsubscribes from candle:close', () => {
    const { bus, exchange } = createExchange();
    exchange.dispose();
    seedPrice(bus, 'ETHUSDT', 3000);
    // Should still have no price for ETHUSDT since handler was removed
    const result = exchange.simulateFill({
      symbol: 'ETHUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 1,
    });
    expect(result.status).toBe('REJECTED');
  });
});

// ──────────────────────────────────────────────
// createBacktestEngine integration tests
// ──────────────────────────────────────────────

describe('createBacktestEngine', () => {
  test('throws for non-backtest-sim config', () => {
    const liveConfig: ExchangeConfig = {
      type: 'binance-live',
      apiKey: 'key',
      privateKey: 'secret',
    };
    expect(() => {
      createBacktestEngine(async () => [], liveConfig);
    }).toThrow("requires 'backtest-sim' config");
  });

  test('full E2E: trades collected and metrics computed', async () => {
    const candles = makeCandles(20, 50_000);
    const loader = async () => candles;
    const engine = createBacktestEngine(loader, simConfig);
    const factory = tradingFactory(3, 10);

    const result = await engine.run(factory, {}, btConfig);

    expect(result.trades.length).toBe(1);
    expect(result.trades[0]?.side).toBe('LONG');
    expect(result.trades[0]?.pnl).toBeGreaterThan(0); // price rises from candle 3→10
    expect(result.metrics.totalTrades).toBe(1);
    expect(result.metrics.winRate).toBe(1);
    expect(result.initialBalance).toBe(10_000);
    expect(result.startTime).toBe(BASE_TIME);
    expect(result.endTime).toBe(btConfig.endTime);
  });

  test('finalBalance comes from exchange balance (includes fees + slippage)', async () => {
    const candles = makeCandles(20, 50_000);
    const loader = async () => candles;
    const engine = createBacktestEngine(loader, simConfig);
    const factory = tradingFactory(3, 10);

    const result = await engine.run(factory, {}, btConfig);
    // Exchange balance is authoritative — includes fees and slippage.
    // Price rises from candle 3 to 10, so profit should be positive.
    expect(result.finalBalance).not.toBe(10_000);
    expect(result.trades[0]!.pnl).toBeGreaterThan(0);
  });

  test('no trades → zero metrics', async () => {
    const candles = makeCandles(5, 50_000);
    const loader = async () => candles;
    const engine = createBacktestEngine(loader, simConfig);
    const factory = tradingFactory(100, 200);

    const result = await engine.run(factory, {}, btConfig);

    expect(result.trades.length).toBe(0);
    expect(result.metrics.totalTrades).toBe(0);
    expect(result.metrics.winRate).toBe(0);
    expect(result.finalBalance).toBe(10_000);
  });

  test('loader called for each symbol × timeframe', async () => {
    const calls: Array<{ symbol: string; tf: string }> = [];
    const loader = async (symbol: string, tf: Timeframe) => {
      calls.push({ symbol, tf });
      return makeCandles(5, 50_000);
    };

    const multiConfig: BacktestConfig = {
      ...btConfig,
      symbols: ['BTCUSDT', 'ETHUSDT'],
      timeframes: ['1m', '5m'],
    };

    const engine = createBacktestEngine(loader, simConfig);
    const factory = tradingFactory(100, 200);

    await engine.run(factory, {}, multiConfig);

    expect(calls.length).toBe(4);
    expect(calls).toContainEqual({ symbol: 'BTCUSDT', tf: '1m' });
    expect(calls).toContainEqual({ symbol: 'BTCUSDT', tf: '5m' });
    expect(calls).toContainEqual({ symbol: 'ETHUSDT', tf: '1m' });
    expect(calls).toContainEqual({ symbol: 'ETHUSDT', tf: '5m' });
  });

  test('order:filled events emitted during run', async () => {
    const candles = makeCandles(20, 50_000);
    const loader = async () => candles;
    const engine = createBacktestEngine(loader, simConfig);

    let filledCount = 0;
    const factory: StrategyFactory = (_params, deps) => {
      let count = 0;
      const candleHandler = (data: { symbol: string; timeframe: Timeframe; candle: Candle }) => {
        count += 1;
        if (count === 5) {
          deps.executor.submit({
            symbol: data.symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: 0.1,
          });
        }
      };
      const fillHandler = () => {
        filledCount += 1;
      };

      deps.bus.on('candle:close', candleHandler);
      deps.bus.on('order:filled', fillHandler);

      return {
        name: 'fill-counter',
        start: () => Promise.resolve(),
        stop: () => {
          deps.bus.off('candle:close', candleHandler);
          deps.bus.off('order:filled', fillHandler);
          return Promise.resolve();
        },
        getStats: () => zeroMetrics,
      };
    };

    await engine.run(factory, {}, btConfig);
    expect(filledCount).toBe(1);
  });
});
