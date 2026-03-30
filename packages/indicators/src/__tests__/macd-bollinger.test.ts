import { describe, test, expect } from 'bun:test';

import { fixtures } from '@trading-bot/test-utils';
import type { Candle } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { MACD, createMACD, Bollinger, createBollinger } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandle(overrides: Partial<Candle> & { close: number }): Candle {
  const close = overrides.close;
  return {
    symbol: overrides.symbol ?? toSymbol('BTCUSDT'),
    openTime: overrides.openTime ?? 0,
    closeTime: overrides.closeTime ?? 59999,
    open: overrides.open ?? close,
    high: overrides.high ?? close + 1,
    low: overrides.low ?? close - 1,
    close,
    volume: overrides.volume ?? 100,
    quoteVolume: overrides.quoteVolume ?? close * 100,
    trades: overrides.trades ?? 50,
    isClosed: overrides.isClosed ?? true,
  };
}

function feedAll<T>(
  indicator: { update(candle: Candle): T | null },
  candles: Candle[],
): (T | null)[] {
  return candles.map((c) => indicator.update(c));
}

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------

describe('MACD', () => {
  test('warmup: returns null until both slow EMA and signal EMA have seeded', () => {
    const macd = new MACD({ fastPeriod: 3, slowPeriod: 5, signalPeriod: 3 });
    // Slow EMA seeds at index 4 (5th candle). Fast EMA seeds at index 2 (3rd candle).
    // MACD line is available from index 4. Signal EMA (period 3) needs 3 MACD values
    // (indices 4, 5, 6) so first non-null output at index 6 (7th candle).
    const results = feedAll(macd, fixtures.candles.slice(0, 8));
    for (let i = 0; i < 6; i++) {
      expect(results[i]).toBeNull();
    }
    expect(results[6]).not.toBeNull();
    expect(results[7]).not.toBeNull();
  });

  test('histogram sign: positive when fast EMA momentum exceeds slow', () => {
    // With monotonically increasing fixture candles, the fast EMA leads the slow EMA,
    // so macdLine = fastEMA - slowEMA > 0. After the signal EMA also warms up,
    // the histogram should be >= 0 (fast trending above slow).
    const macd = new MACD({ fastPeriod: 3, slowPeriod: 5, signalPeriod: 3 });
    const results = feedAll(macd, fixtures.candles.slice(0, 20));
    const nonNull = results.filter((r): r is number => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    // All histogram values should be non-negative for steadily rising prices
    for (const val of nonNull) {
      expect(val).toBeGreaterThanOrEqual(0);
    }
  });

  test('histogram sign: negative when prices reverse down', () => {
    // Build candles: first go up, then reverse sharply down
    const closes = [
      100, 105, 110, 115, 120, // up
      125, 130, 135, 140, 145, // more up to warm up
      140, 130, 120, 110, 100, // down reversal
      90, 80, 70, 60, 50,      // steep decline
    ];
    const candles = closes.map((close, i) => makeCandle({ close, openTime: i * 60000 }));
    const macd = new MACD({ fastPeriod: 3, slowPeriod: 5, signalPeriod: 3 });
    const results = feedAll(macd, candles);
    // The last few histogram values should be negative after the reversal
    const last = results[results.length - 1];
    expect(last).not.toBeNull();
    expect(last!).toBeLessThan(0);
  });

  test('reset: same candles produce same output after reset()', () => {
    const macd = new MACD({ fastPeriod: 3, slowPeriod: 5, signalPeriod: 3 });
    const first = feedAll(macd, fixtures.candles.slice(0, 20));
    macd.reset();
    const second = feedAll(macd, fixtures.candles.slice(0, 20));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createMACD({ fastPeriod: 3, slowPeriod: 5, signalPeriod: 3 });
    const b = createMACD({ fastPeriod: 3, slowPeriod: 5, signalPeriod: 3 });
    for (let i = 0; i < 10; i++) {
      a.update(fixtures.candles[i]!);
    }
    expect(b.update(fixtures.candles[0]!)).toBeNull();
  });

  test('constructor throws for invalid periods', () => {
    expect(() => new MACD({ fastPeriod: 0, slowPeriod: 5, signalPeriod: 3 })).toThrow();
    expect(() => new MACD({ fastPeriod: 3, slowPeriod: -1, signalPeriod: 3 })).toThrow();
    expect(() => new MACD({ fastPeriod: 3, slowPeriod: 5, signalPeriod: 1.5 })).toThrow();
  });

  test('name and warmupPeriod are correct', () => {
    const macd = new MACD({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    expect(macd.name).toBe('MACD');
    expect(macd.warmupPeriod).toBe(35); // 26 + 9
    expect(macd.config).toEqual({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  });
});

// ---------------------------------------------------------------------------
// Bollinger
// ---------------------------------------------------------------------------

describe('Bollinger', () => {
  test('warmup: first (period-1) calls return null, period-th returns a value', () => {
    const bb = new Bollinger({ period: 5, stdDevMultiplier: 2 });
    const results = feedAll(bb, fixtures.candles.slice(0, 6));
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
    expect(results[3]).toBeNull();
    expect(results[4]).not.toBeNull();
    expect(results[5]).not.toBeNull();
  });

  test('returns ~0.5 when price equals SMA', () => {
    // All same close price: SMA = close, stdDev = 0, should return 0.5
    const candles = Array.from({ length: 5 }, (_, i) =>
      makeCandle({ close: 100, openTime: i * 60000 }),
    );
    const bb = new Bollinger({ period: 5, stdDevMultiplier: 2 });
    const results = feedAll(bb, candles);
    expect(results[4]).toBe(0.5);
  });

  test('returns > 1 when price is above upper band', () => {
    // 4 candles at 100, then a spike to 300 — close will be above the upper band
    // SMA = (100*4 + 300)/5 = 140, variance = (40^2*4 + 160^2)/5 = 7680, stdDev ~= 87.6
    // Upper = 140 + 2*87.6 = 315.3 ... close (300) is still inside. Use multiplier=1:
    // Upper = 140 + 87.6 = 227.6, close (300) > 227.6 => %B > 1
    const closes = [100, 100, 100, 100, 300];
    const candles = closes.map((close, i) => makeCandle({ close, openTime: i * 60000 }));
    const bb = new Bollinger({ period: 5, stdDevMultiplier: 1 });
    const results = feedAll(bb, candles);
    expect(results[4]).not.toBeNull();
    expect(results[4]!).toBeGreaterThan(1);
  });

  test('returns < 0 when price is below lower band', () => {
    // 4 candles at 300, then a drop to 100 — close will be below the lower band (multiplier=1)
    const closes = [300, 300, 300, 300, 100];
    const candles = closes.map((close, i) => makeCandle({ close, openTime: i * 60000 }));
    const bb = new Bollinger({ period: 5, stdDevMultiplier: 1 });
    const results = feedAll(bb, candles);
    expect(results[4]).not.toBeNull();
    expect(results[4]!).toBeLessThan(0);
  });

  test('returns value between 0 and 1 for normal price within bands', () => {
    // Steady increasing prices — the latest close should be within 1 standard deviation
    const bb = new Bollinger({ period: 5, stdDevMultiplier: 2 });
    const results = feedAll(bb, fixtures.candles.slice(0, 10));
    const lastNonNull = results.filter((r): r is number => r !== null);
    expect(lastNonNull.length).toBeGreaterThan(0);
    // With steady linear increases, %B should be near 0.5-1.0
    for (const val of lastNonNull) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  test('reset: same candles produce same output after reset()', () => {
    const bb = new Bollinger({ period: 5, stdDevMultiplier: 2 });
    const first = feedAll(bb, fixtures.candles.slice(0, 15));
    bb.reset();
    const second = feedAll(bb, fixtures.candles.slice(0, 15));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createBollinger({ period: 5, stdDevMultiplier: 2 });
    const b = createBollinger({ period: 5, stdDevMultiplier: 2 });
    for (let i = 0; i < 7; i++) {
      a.update(fixtures.candles[i]!);
    }
    expect(b.update(fixtures.candles[0]!)).toBeNull();
  });

  test('constructor throws for invalid config', () => {
    expect(() => new Bollinger({ period: 0, stdDevMultiplier: 2 })).toThrow();
    expect(() => new Bollinger({ period: 5, stdDevMultiplier: -1 })).toThrow();
  });

  test('name and warmupPeriod are correct', () => {
    const bb = new Bollinger({ period: 20, stdDevMultiplier: 2 });
    expect(bb.name).toBe('Bollinger');
    expect(bb.warmupPeriod).toBe(20);
    expect(bb.config).toEqual({ period: 20, stdDevMultiplier: 2 });
  });
});
