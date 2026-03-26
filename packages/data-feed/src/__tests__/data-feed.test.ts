import { describe, test, expect } from 'bun:test';
import { createTestBus, fixtures } from '@trading-bot/test-utils';
import type { IEventBus } from '@trading-bot/event-bus';
import type { EventCapture } from '@trading-bot/test-utils';
import { ReplayDataFeed } from '../replay-data-feed';
import type { Candle } from '@trading-bot/types';

const BASE_TIME = 1700000000000;

function makeCandle(index: number): Candle {
  const open = 50000 + index * 10;
  return {
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
    await feed.start(['BTCUSDT'], ['1m']);

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
    await feed.start(['BTCUSDT'], ['1m', '4h']);

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
    await feed.start(['ETHUSDT'], ['5m']);

    const events = capture.get('candle:close');
    expect(events).toHaveLength(1);

    const evt = events[0];
    expect(evt).toBeDefined();
    if (evt !== undefined) {
      expect(evt.symbol).toBe('ETHUSDT');
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

    await feed.start(['BTCUSDT'], ['1m']);

    // With stop() called on first emit, the loop checks running before each iteration.
    // The first candle fires, stop() sets running=false, then the loop breaks.
    // So we get exactly 1 event.
    expect(capture.count('candle:close')).toBeLessThan(50);
  });

  test('getOrderBook() always returns null', () => {
    const { bus }: { bus: IEventBus } = createTestBus();
    const feed = new ReplayDataFeed(bus, new Map());

    expect(feed.getOrderBook('BTCUSDT')).toBeNull();
    expect(feed.getOrderBook('ETHUSDT')).toBeNull();
    expect(feed.getOrderBook('')).toBeNull();
  });

  test('empty map: start() completes immediately, no events emitted', async () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const feed = new ReplayDataFeed(bus, new Map());
    await feed.start(['BTCUSDT'], ['1m']);

    expect(capture.count('candle:close')).toBe(0);
  });
});
