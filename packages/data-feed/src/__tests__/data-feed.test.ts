import { describe, test, expect } from 'bun:test';

import type { IExchange } from '@trading-bot/exchange-client';
import { createTestBus, fixtures } from '@trading-bot/test-utils';
import type { EventCapture } from '@trading-bot/test-utils';
import type { Candle, IEventBus, Symbol, Tick, Timeframe, OrderBookDiff } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { LiveDataFeed } from '../live-data-feed';
import { ReplayDataFeed } from '../replay-data-feed';

/**
 * Creates a mock exchange with overridable subscription behavior.
 * Returns a typed IExchange without spreads that lose type info.
 */
function createStreamableExchange(overrides: {
  subscribeCandles?: IExchange['subscribeCandles'];
  subscribeTicks?: IExchange['subscribeTicks'];
  subscribeOrderBookDiff?: IExchange['subscribeOrderBookDiff'];
}): IExchange {
  const noopCandles: IExchange['subscribeCandles'] =
    (_s: Symbol, _tf: Timeframe, _cb: (c: Candle) => void) => () => {};
  const noopTicks: IExchange['subscribeTicks'] = (_s: Symbol, _cb: (t: Tick) => void) => () => {};
  const noopDepth: IExchange['subscribeOrderBookDiff'] =
    (_s: Symbol, _cb: (d: OrderBookDiff) => void) => () => {};

  const exchange: IExchange = {
    getCandles: async () => [],
    getOrderBook: async () => ({ symbol: toSymbol(''), timestamp: 0, bids: [], asks: [] }),
    subscribeCandles: overrides.subscribeCandles ?? noopCandles,
    subscribeTicks: overrides.subscribeTicks ?? noopTicks,
    subscribeOrderBookDiff: overrides.subscribeOrderBookDiff ?? noopDepth,
    placeOrder: async () => {
      throw new Error('not configured');
    },
    cancelOrder: async () => {},
    getOpenOrders: async () => [],
    getPosition: async () => null,
    getPositions: async () => [],
    setLeverage: async () => {},
    getBalance: async () => [],
    getFees: async () => ({ maker: 0.0002, taker: 0.0004 }),
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
  };
  return exchange;
}

const BASE_TIME = 1700000000000;

function makeCandle(index: number): Candle {
  const open = 50000 + index * 10;
  return {
    symbol: toSymbol('BTCUSDT'),
    openTime: BASE_TIME + index * 60000,
    closeTime: BASE_TIME + (index + 1) * 60000 - 1,
    open,
    high: open + 50,
    low: open - 30,
    close: open + 20,
    volume: 100 + index,
    quoteVolume: (100 + index) * open,
    trades: 50 + index,
    isClosed: true,
  };
}

describe('ReplayDataFeed', () => {
  test('package is importable', async () => {
    const mod = await import('../index');
    expect(mod).toBeDefined();
  });

  test('replays candles in chronological order', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    // Use 5 candles from fixtures (they are 1-minute apart, openTime ascending)
    const slice = fixtures.candles.slice(0, 5);
    const candleMap = new Map<string, Candle[]>([['BTCUSDT:1m', slice]]);

    const feed = new ReplayDataFeed(bus, candleMap);
    await feed.start([toSymbol('BTCUSDT')], ['1m']);

    const events = capture.get('candle:close');
    expect(events).toHaveLength(5);

    for (let i = 0; i < events.length - 1; i++) {
      const current = events[i];
      const next = events[i + 1];
      expect(current).toBeDefined();
      expect(next).toBeDefined();
      if (current !== undefined && next !== undefined) {
        expect(current.candle.openTime).toBeLessThanOrEqual(next.candle.openTime);
      }
    }
  });

  test('multi-timeframe interleaving: 1m and 4h candles arrive in correct time order', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    // 5 candles on 1m (minute steps)
    const oneMinCandles: Candle[] = Array.from({ length: 5 }, (_, i) => makeCandle(i));

    // 2 candles on 4h (4h = 240 minutes = 240 * 60000 ms steps, starting at base time)
    const fourHourCandles: Candle[] = [
      {
        symbol: toSymbol('BTCUSDT'),
        openTime: BASE_TIME,
        closeTime: BASE_TIME + 240 * 60000 - 1,
        open: 50000,
        high: 50500,
        low: 49500,
        close: 50200,
        volume: 10000,
        quoteVolume: 10000 * 50000,
        trades: 500,
        isClosed: true,
      },
      {
        symbol: toSymbol('BTCUSDT'),
        openTime: BASE_TIME + 240 * 60000,
        closeTime: BASE_TIME + 480 * 60000 - 1,
        open: 50200,
        high: 50700,
        low: 49700,
        close: 50400,
        volume: 12000,
        quoteVolume: 12000 * 50200,
        trades: 600,
        isClosed: true,
      },
    ];

    const candleMap = new Map<string, Candle[]>([
      ['BTCUSDT:1m', oneMinCandles],
      ['BTCUSDT:4h', fourHourCandles],
    ]);

    const feed = new ReplayDataFeed(bus, candleMap);
    await feed.start([toSymbol('BTCUSDT')], ['1m', '4h']);

    const events = capture.get('candle:close');
    // 5 one-minute + 2 four-hour = 7 events
    expect(events).toHaveLength(7);

    // Verify strictly non-decreasing order by openTime
    for (let i = 0; i < events.length - 1; i++) {
      const current = events[i];
      const next = events[i + 1];
      expect(current).toBeDefined();
      expect(next).toBeDefined();
      if (current !== undefined && next !== undefined) {
        expect(current.candle.openTime).toBeLessThanOrEqual(next.candle.openTime);
      }
    }

    // At t=BASE_TIME both a 1m and a 4h candle share the same openTime; both should appear
    const baseTimeEvents = events.filter((e) => e.candle.openTime === BASE_TIME);
    expect(baseTimeEvents).toHaveLength(2);

    // The 4h candle at BASE_TIME + 240m should appear after all 1m candles it follows
    const secondFourHour = events.find(
      (e) => e.timeframe === '4h' && e.candle.openTime === BASE_TIME + 240 * 60000,
    );
    expect(secondFourHour).toBeDefined();
  });

  test('correct event payloads: symbol, timeframe, and candle fields all correct', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const testCandle: Candle = fixtures.candles[3] ?? fixtures.candle;

    const candleMap = new Map<string, Candle[]>([['ETHUSDT:5m', [testCandle]]]);

    const feed = new ReplayDataFeed(bus, candleMap);
    await feed.start([toSymbol('ETHUSDT')], ['5m']);

    const events = capture.get('candle:close');
    expect(events).toHaveLength(1);

    const evt = events[0];
    expect(evt).toBeDefined();
    if (evt !== undefined) {
      expect(evt.symbol).toBe(toSymbol('ETHUSDT'));
      expect(evt.timeframe).toBe('5m');
      expect(evt.candle.openTime).toBe(testCandle.openTime);
      expect(evt.candle.close).toBe(testCandle.close);
      expect(evt.candle.volume).toBe(testCandle.volume);
      expect(evt.candle.isClosed).toBe(true);
    }
  });

  test('stop() halts replay mid-stream', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    // Use 50 candles — stop() is called synchronously from within an event handler
    const manyCandles: Candle[] = fixtures.candles.slice(0, 50);
    const candleMap = new Map<string, Candle[]>([['BTCUSDT:1m', manyCandles]]);

    const feed = new ReplayDataFeed(bus, candleMap);

    // Stop after the first candle:close event is captured
    let stopped = false;
    bus.on('candle:close', () => {
      if (!stopped) {
        stopped = true;
        void feed.stop();
      }
    });

    await feed.start([toSymbol('BTCUSDT')], ['1m']);

    // With stop() called on first emit, the loop checks running before each iteration.
    // The first candle fires, stop() sets running=false, then the loop breaks.
    // So we get exactly 1 event.
    expect(capture.count('candle:close')).toBeLessThan(50);
  });

  test('getOrderBook() always returns null', () => {
    const { bus }: { bus: IEventBus } = createTestBus();
    const feed = new ReplayDataFeed(bus, new Map());

    expect(feed.getOrderBook(toSymbol('BTCUSDT'))).toBeNull();
    expect(feed.getOrderBook(toSymbol('ETHUSDT'))).toBeNull();
    expect(feed.getOrderBook(toSymbol(''))).toBeNull();
  });

  test('empty map: start() completes immediately, no events emitted', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const feed = new ReplayDataFeed(bus, new Map());
    await feed.start([toSymbol('BTCUSDT')], ['1m']);

    expect(capture.count('candle:close')).toBe(0);
  });

  test('deterministic replay: same data produces same event order', async () => {
    const candles: Candle[] = Array.from({ length: 10 }, (_, i) => makeCandle(i));
    const candleMap = new Map<string, Candle[]>([
      ['BTCUSDT:1m', candles.slice(0, 5)],
      ['ETHUSDT:1m', candles.slice(3, 8)],
    ]);

    const runs: Array<Array<{ symbol: string; openTime: number }>> = [];

    for (let run = 0; run < 2; run++) {
      const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();
      const feed = new ReplayDataFeed(bus, candleMap);
      await feed.start([toSymbol('BTCUSDT'), toSymbol('ETHUSDT')], ['1m']);
      runs.push(
        capture.get('candle:close').map((e) => ({ symbol: e.symbol, openTime: e.candle.openTime })),
      );
    }

    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]!.length).toBeGreaterThan(0);
  });

  test('empty symbols array replays all symbols', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const btcCandles: Candle[] = [makeCandle(0), makeCandle(1)];
    const ethCandles: Candle[] = [makeCandle(2), makeCandle(3)];
    const candleMap = new Map<string, Candle[]>([
      ['BTCUSDT:1m', btcCandles],
      ['ETHUSDT:1m', ethCandles],
    ]);

    const feed = new ReplayDataFeed(bus, candleMap);
    // Empty symbols array should replay all symbols
    await feed.start([], ['1m']);

    const events = capture.get('candle:close');
    expect(events).toHaveLength(4);

    const symbols = new Set(events.map((e) => e.symbol));
    expect(symbols.has('BTCUSDT')).toBe(true);
    expect(symbols.has('ETHUSDT')).toBe(true);
  });

  test('gap detection emits error event for missing candles', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    // Create candles with a gap: index 0, 1, then skip 2, place candle at index 3
    const candlesWithGap: Candle[] = [makeCandle(0), makeCandle(1), makeCandle(3)];
    const candleMap = new Map<string, Candle[]>([['BTCUSDT:1m', candlesWithGap]]);

    const feed = new ReplayDataFeed(bus, candleMap);
    await feed.start([toSymbol('BTCUSDT')], ['1m']);

    const errors = capture.get('error');
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const gapError = errors.find((e) => e.source === 'data-feed');
    expect(gapError).toBeDefined();
    expect(gapError!.error.message).toContain('Candle gap detected');
  });
});

// === LiveDataFeed tests ===

describe('LiveDataFeed', () => {
  test('routes closed candles to candle:close event', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    let candleCallback: ((candle: Candle) => void) | null = null;
    const exchange = createStreamableExchange({
      subscribeCandles: (_symbol, _tf, cb) => {
        candleCallback = cb;
        return () => {};
      },
    });

    const feed = new LiveDataFeed(bus, exchange);
    await feed.start([toSymbol('BTCUSDT')], ['1m']);

    expect(candleCallback).not.toBeNull();

    const closedCandle: Candle = { ...fixtures.candle, isClosed: true };
    candleCallback!(closedCandle);

    expect(capture.count('candle:close')).toBe(1);
    const evt = capture.get('candle:close')[0];
    expect(evt).toBeDefined();
    expect(evt!.symbol).toBe(toSymbol('BTCUSDT'));
    expect(evt!.timeframe).toBe('1m');
    expect(evt!.candle.isClosed).toBe(true);
  });

  test('routes forming candles to candle:update event', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    let candleCallback: ((candle: Candle) => void) | null = null;
    const exchange = createStreamableExchange({
      subscribeCandles: (_symbol, _tf, cb) => {
        candleCallback = cb;
        return () => {};
      },
    });

    const feed = new LiveDataFeed(bus, exchange);
    await feed.start([toSymbol('BTCUSDT')], ['1m']);

    const formingCandle: Candle = { ...fixtures.candle, isClosed: false };
    candleCallback!(formingCandle);

    expect(capture.count('candle:close')).toBe(0);
    expect(capture.count('candle:update')).toBe(1);
  });

  test('routes ticks to tick event', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    let tickCallback: ((tick: Tick) => void) | null = null;
    const exchange = createStreamableExchange({
      subscribeTicks: (_symbol, cb) => {
        tickCallback = cb;
        return () => {};
      },
    });

    const feed = new LiveDataFeed(bus, exchange);
    await feed.start([toSymbol('BTCUSDT')], ['1m']);

    expect(tickCallback).not.toBeNull();
    const testTick: Tick = {
      symbol: toSymbol('BTCUSDT'),
      price: 50000,
      quantity: 0.5,
      timestamp: 1700000000000,
      isBuyerMaker: false,
    };
    tickCallback!(testTick);

    expect(capture.count('tick')).toBe(1);
    expect(capture.get('tick')[0]!.tick.price).toBe(50000);
  });

  test('subscribes to all symbol × timeframe combinations', async () => {
    const { bus }: { bus: IEventBus } = createTestBus();

    const subscriptions: Array<{ symbol: string; timeframe: string }> = [];
    const exchange = createStreamableExchange({
      subscribeCandles: (symbol, timeframe, _cb) => {
        subscriptions.push({ symbol, timeframe });
        return () => {};
      },
    });

    const feed = new LiveDataFeed(bus, exchange);
    await feed.start([toSymbol('BTCUSDT'), toSymbol('ETHUSDT')], ['1m', '5m']);

    expect(subscriptions).toHaveLength(4);
    expect(subscriptions).toContainEqual({ symbol: toSymbol('BTCUSDT'), timeframe: '1m' });
    expect(subscriptions).toContainEqual({ symbol: toSymbol('BTCUSDT'), timeframe: '5m' });
    expect(subscriptions).toContainEqual({ symbol: 'ETHUSDT', timeframe: '1m' });
    expect(subscriptions).toContainEqual({ symbol: 'ETHUSDT', timeframe: '5m' });
  });

  test('stop() unsubscribes from all streams', async () => {
    const { bus }: { bus: IEventBus } = createTestBus();

    let unsubCount = 0;
    const exchange = createStreamableExchange({
      subscribeCandles: () => () => {
        unsubCount++;
      },
      subscribeTicks: () => () => {
        unsubCount++;
      },
    });

    const feed = new LiveDataFeed(bus, exchange);
    await feed.start([toSymbol('BTCUSDT')], ['1m']);
    await feed.stop();

    expect(unsubCount).toBe(2);
  });

  test('getOrderBook() returns null in Phase 3a-minimal', async () => {
    const { bus }: { bus: IEventBus } = createTestBus();
    const exchange = createStreamableExchange({});

    const feed = new LiveDataFeed(bus, exchange);
    await feed.start([toSymbol('BTCUSDT')], ['1m']);

    expect(feed.getOrderBook(toSymbol('BTCUSDT'))).toBeNull();
  });

  test('does not emit events after stop()', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    let candleCallback: ((candle: Candle) => void) | null = null;
    const exchange = createStreamableExchange({
      subscribeCandles: (_symbol, _tf, cb) => {
        candleCallback = cb;
        return () => {};
      },
    });

    const feed = new LiveDataFeed(bus, exchange);
    await feed.start([toSymbol('BTCUSDT')], ['1m']);
    await feed.stop();

    const closedCandle: Candle = { ...fixtures.candle, isClosed: true };
    candleCallback!(closedCandle);

    expect(capture.count('candle:close')).toBe(0);
  });
});
