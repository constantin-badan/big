import { describe, test, expect } from 'bun:test';

import { fixtures } from '@trading-bot/test-utils';
import type { Candle } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import {
  StochRSI,
  createStochRSI,
  Keltner,
  createKeltner,
  Donchian,
  createDonchian,
} from '../index';

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
// StochRSI
// ---------------------------------------------------------------------------

describe('StochRSI', () => {
  test('warmup: returns null until rsiPeriod + stochPeriod candles', () => {
    const stochRsi = new StochRSI({ rsiPeriod: 3, stochPeriod: 3 });
    // RSI warmup = 3 + 1 = 4 candles (first RSI at index 3), then 2 more candles
    // to fill stochPeriod=3 window. Total warmup = 3 + 3 = 6, first non-null at index 5.
    const results = feedAll(stochRsi, fixtures.candles.slice(0, 10));
    for (let i = 0; i < 5; i++) {
      expect(results[i]).toBeNull();
    }
    expect(results[5]).not.toBeNull();
  });

  test('returns values in 0-100 range', () => {
    const stochRsi = new StochRSI({ rsiPeriod: 3, stochPeriod: 3 });
    const results = feedAll(stochRsi, fixtures.candles.slice(0, 20));
    const nonNull = results.filter((r): r is number => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    for (const val of nonNull) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(100);
    }
  });

  test('returns 50 when all RSI values in window are equal', () => {
    // Feed identical prices so RSI is always 50 (no movement)
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle({ close: 100, openTime: i * 60000 }),
    );
    const stochRsi = new StochRSI({ rsiPeriod: 3, stochPeriod: 3 });
    const results = feedAll(stochRsi, candles);
    const nonNull = results.filter((r): r is number => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    // All RSI values are 50, so min == max => returns 50
    for (const val of nonNull) {
      expect(val).toBe(50);
    }
  });

  test('reset: same candles produce same output after reset()', () => {
    const stochRsi = new StochRSI({ rsiPeriod: 3, stochPeriod: 3 });
    const first = feedAll(stochRsi, fixtures.candles.slice(0, 20));
    stochRsi.reset();
    const second = feedAll(stochRsi, fixtures.candles.slice(0, 20));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createStochRSI({ rsiPeriod: 3, stochPeriod: 3 });
    const b = createStochRSI({ rsiPeriod: 3, stochPeriod: 3 });
    for (let i = 0; i < 10; i++) {
      a.update(fixtures.candles[i]!);
    }
    expect(b.update(fixtures.candles[0]!)).toBeNull();
  });

  test('constructor throws for invalid config', () => {
    expect(() => new StochRSI({ rsiPeriod: 0, stochPeriod: 3 })).toThrow();
    expect(() => new StochRSI({ rsiPeriod: 3, stochPeriod: -1 })).toThrow();
    expect(() => new StochRSI({ rsiPeriod: 1.5, stochPeriod: 3 })).toThrow();
    expect(() => new StochRSI({ rsiPeriod: 3, stochPeriod: 2.5 })).toThrow();
  });

  test('name and warmupPeriod are correct', () => {
    const stochRsi = new StochRSI({ rsiPeriod: 14, stochPeriod: 14 });
    expect(stochRsi.name).toBe('StochRSI');
    expect(stochRsi.warmupPeriod).toBe(28); // 14 + 14
    expect(stochRsi.config).toEqual({ rsiPeriod: 14, stochPeriod: 14 });
  });
});

// ---------------------------------------------------------------------------
// Keltner
// ---------------------------------------------------------------------------

describe('Keltner', () => {
  test('warmup: returns null until max(emaPeriod, atrPeriod) candles', () => {
    const kc = new Keltner({ emaPeriod: 5, atrPeriod: 3, atrMultiplier: 2 });
    // warmup = max(5, 3) = 5, first non-null at index 4 (5th candle)
    const results = feedAll(kc, fixtures.candles.slice(0, 8));
    for (let i = 0; i < 4; i++) {
      expect(results[i]).toBeNull();
    }
    expect(results[4]).not.toBeNull();
  });

  test('returns ~0.5 when close equals EMA', () => {
    // All same close — EMA = close, ATR reflects high-low range but position is centered
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle({ close: 100, high: 101, low: 99, openTime: i * 60000 }),
    );
    const kc = new Keltner({ emaPeriod: 5, atrPeriod: 5, atrMultiplier: 2 });
    const results = feedAll(kc, candles);
    const nonNull = results.filter((r): r is number => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    // close = EMA = middle of channel => should be ~0.5
    for (const val of nonNull) {
      expect(val).toBeCloseTo(0.5, 1);
    }
  });

  test('returns 0.5 when bands have zero width', () => {
    // All identical OHLC => ATR = 0, bandwidth = 0, should return 0.5
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle({ close: 100, high: 100, low: 100, open: 100, openTime: i * 60000 }),
    );
    const kc = new Keltner({ emaPeriod: 5, atrPeriod: 5, atrMultiplier: 2 });
    const results = feedAll(kc, candles);
    const nonNull = results.filter((r): r is number => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    for (const val of nonNull) {
      expect(val).toBe(0.5);
    }
  });

  test('returns > 0.5 when price trends up relative to EMA', () => {
    // Rising prices: close should be above EMA => normalized position > 0.5
    const kc = new Keltner({ emaPeriod: 5, atrPeriod: 5, atrMultiplier: 2 });
    const results = feedAll(kc, fixtures.candles.slice(0, 20));
    const nonNull = results.filter((r): r is number => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    // For steadily rising fixture candles, later values should be above 0.5
    const last = nonNull[nonNull.length - 1]!;
    expect(last).toBeGreaterThanOrEqual(0.5);
  });

  test('reset: same candles produce same output after reset()', () => {
    const kc = new Keltner({ emaPeriod: 5, atrPeriod: 3, atrMultiplier: 2 });
    const first = feedAll(kc, fixtures.candles.slice(0, 20));
    kc.reset();
    const second = feedAll(kc, fixtures.candles.slice(0, 20));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createKeltner({ emaPeriod: 5, atrPeriod: 3, atrMultiplier: 2 });
    const b = createKeltner({ emaPeriod: 5, atrPeriod: 3, atrMultiplier: 2 });
    for (let i = 0; i < 10; i++) {
      a.update(fixtures.candles[i]!);
    }
    expect(b.update(fixtures.candles[0]!)).toBeNull();
  });

  test('constructor throws for invalid config', () => {
    expect(() => new Keltner({ emaPeriod: 0, atrPeriod: 3, atrMultiplier: 2 })).toThrow();
    expect(() => new Keltner({ emaPeriod: 5, atrPeriod: -1, atrMultiplier: 2 })).toThrow();
    expect(() => new Keltner({ emaPeriod: 5, atrPeriod: 3, atrMultiplier: 0 })).toThrow();
    expect(() => new Keltner({ emaPeriod: 1.5, atrPeriod: 3, atrMultiplier: 2 })).toThrow();
    expect(() => new Keltner({ emaPeriod: 5, atrPeriod: 2.5, atrMultiplier: 2 })).toThrow();
  });

  test('name and warmupPeriod are correct', () => {
    const kc = new Keltner({ emaPeriod: 20, atrPeriod: 10, atrMultiplier: 2 });
    expect(kc.name).toBe('Keltner');
    expect(kc.warmupPeriod).toBe(20); // max(20, 10)
    expect(kc.config).toEqual({ emaPeriod: 20, atrPeriod: 10, atrMultiplier: 2 });
  });
});

// ---------------------------------------------------------------------------
// Donchian
// ---------------------------------------------------------------------------

describe('Donchian', () => {
  test('warmup: returns null until period candles', () => {
    const dc = new Donchian({ period: 5 });
    const results = feedAll(dc, fixtures.candles.slice(0, 8));
    for (let i = 0; i < 4; i++) {
      expect(results[i]).toBeNull();
    }
    expect(results[4]).not.toBeNull();
  });

  test('returns 0.5 when all candles are identical', () => {
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle({ close: 100, high: 100, low: 100, openTime: i * 60000 }),
    );
    const dc = new Donchian({ period: 5 });
    const results = feedAll(dc, candles);
    const nonNull = results.filter((r): r is number => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    for (const val of nonNull) {
      expect(val).toBe(0.5);
    }
  });

  test('returns 1.0 when close equals upper channel', () => {
    // close = high for all candles, and all lows are lower
    const candles = Array.from({ length: 5 }, (_, i) =>
      makeCandle({ close: 110, high: 110, low: 90, openTime: i * 60000 }),
    );
    const dc = new Donchian({ period: 5 });
    const results = feedAll(dc, candles);
    // upper = 110, lower = 90, close = 110 => (110-90)/(110-90) = 1.0
    expect(results[4]).toBe(1);
  });

  test('returns 0.0 when close equals lower channel', () => {
    // close = low for all candles
    const candles = Array.from({ length: 5 }, (_, i) =>
      makeCandle({ close: 90, high: 110, low: 90, openTime: i * 60000 }),
    );
    const dc = new Donchian({ period: 5 });
    const results = feedAll(dc, candles);
    // upper = 110, lower = 90, close = 90 => (90-90)/(110-90) = 0.0
    expect(results[4]).toBe(0);
  });

  test('returns values between 0 and 1 for normal data', () => {
    const dc = new Donchian({ period: 5 });
    const results = feedAll(dc, fixtures.candles.slice(0, 20));
    const nonNull = results.filter((r): r is number => r !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    for (const val of nonNull) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  test('reset: same candles produce same output after reset()', () => {
    const dc = new Donchian({ period: 5 });
    const first = feedAll(dc, fixtures.candles.slice(0, 15));
    dc.reset();
    const second = feedAll(dc, fixtures.candles.slice(0, 15));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createDonchian({ period: 5 });
    const b = createDonchian({ period: 5 });
    for (let i = 0; i < 10; i++) {
      a.update(fixtures.candles[i]!);
    }
    expect(b.update(fixtures.candles[0]!)).toBeNull();
  });

  test('constructor throws for invalid config', () => {
    expect(() => new Donchian({ period: 0 })).toThrow();
    expect(() => new Donchian({ period: -5 })).toThrow();
    expect(() => new Donchian({ period: 3.5 })).toThrow();
  });

  test('name and warmupPeriod are correct', () => {
    const dc = new Donchian({ period: 20 });
    expect(dc.name).toBe('Donchian');
    expect(dc.warmupPeriod).toBe(20);
    expect(dc.config).toEqual({ period: 20 });
  });
});
