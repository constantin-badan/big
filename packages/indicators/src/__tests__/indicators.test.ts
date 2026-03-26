import { describe, test, expect } from 'bun:test';

import { fixtures } from '@trading-bot/test-utils';
import type { Candle } from '@trading-bot/types';

import {
  SMA,
  createSMA,
  EMA,
  createEMA,
  RSI,
  createRSI,
  ATR,
  createATR,
  VWAP,
  createVWAP,
} from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandle(overrides: Partial<Candle> & { close: number }): Candle {
  const close = overrides.close;
  return {
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

// Feed an array of candles into an indicator, return all outputs
function feedAll<T>(
  indicator: { update(candle: Candle): T | null },
  candles: Candle[],
): (T | null)[] {
  return candles.map((c) => indicator.update(c));
}

// ---------------------------------------------------------------------------
// SMA
// ---------------------------------------------------------------------------

describe('SMA', () => {
  test('warmup: first (period-1) calls return null, period-th returns a value', () => {
    const sma = new SMA({ period: 5 });
    const results = feedAll(sma, fixtures.candles.slice(0, 6));
    // indices 0-3 → null, index 4 → number, index 5 → number
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
    expect(results[3]).toBeNull();
    expect(results[4]).not.toBeNull();
    expect(results[5]).not.toBeNull();
  });

  test('known value: SMA(5) at index 4 = 50040', () => {
    const sma = new SMA({ period: 5 });
    let last: number | null = null;
    for (let i = 0; i <= 4; i++) {
      last = sma.update(fixtures.candles[i]!);
    }
    // closes[0..4] = 50020,50030,50040,50050,50060 → avg = 50040
    expect(last).toBe(50040);
  });

  test('reset: same candles produce same output after reset()', () => {
    const sma = new SMA({ period: 5 });
    const first = feedAll(sma, fixtures.candles.slice(0, 10));
    sma.reset();
    const second = feedAll(sma, fixtures.candles.slice(0, 10));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createSMA({ period: 5 });
    const b = createSMA({ period: 5 });
    // Feed 5 candles into a only
    for (let i = 0; i < 5; i++) {
      a.update(fixtures.candles[i]!);
    }
    // b should still be in warmup
    expect(b.update(fixtures.candles[0]!)).toBeNull();
  });

  test('name and warmupPeriod are correct', () => {
    const sma = new SMA({ period: 10 });
    expect(sma.name).toBe('SMA');
    expect(sma.warmupPeriod).toBe(10);
    expect(sma.config).toEqual({ period: 10 });
  });
});

// ---------------------------------------------------------------------------
// EMA
// ---------------------------------------------------------------------------

describe('EMA', () => {
  test('warmup: first (period-1) calls return null, period-th returns a value', () => {
    const ema = new EMA({ period: 5 });
    const results = feedAll(ema, fixtures.candles.slice(0, 6));
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
    expect(results[3]).toBeNull();
    expect(results[4]).not.toBeNull(); // seed at index 4
    expect(results[5]).not.toBeNull();
  });

  test('known value: EMA(5) at index 4 equals SMA seed = 50040', () => {
    const ema = new EMA({ period: 5 });
    let last: number | null = null;
    for (let i = 0; i <= 4; i++) {
      last = ema.update(fixtures.candles[i]!);
    }
    expect(last).toBe(50040);
  });

  test('known value: EMA(5) at index 5 = 50050', () => {
    // EMA = seed + (2/6) * (close[5] - seed) = 50040 + (1/3) * 30 = 50040 + 10 = 50050
    const ema = new EMA({ period: 5 });
    let last: number | null = null;
    for (let i = 0; i <= 5; i++) {
      last = ema.update(fixtures.candles[i]!);
    }
    expect(last).toBe(50050);
  });

  test('reset: same candles produce same output after reset()', () => {
    const ema = new EMA({ period: 5 });
    const first = feedAll(ema, fixtures.candles.slice(0, 10));
    ema.reset();
    const second = feedAll(ema, fixtures.candles.slice(0, 10));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createEMA({ period: 5 });
    const b = createEMA({ period: 5 });
    for (let i = 0; i < 5; i++) {
      a.update(fixtures.candles[i]!);
    }
    expect(b.update(fixtures.candles[0]!)).toBeNull();
  });

  test('name and warmupPeriod are correct', () => {
    const ema = new EMA({ period: 14 });
    expect(ema.name).toBe('EMA');
    expect(ema.warmupPeriod).toBe(14);
    expect(ema.config).toEqual({ period: 14 });
  });
});

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------

describe('RSI', () => {
  // Custom candles with mixed gains/losses for meaningful RSI values
  // Closes: 100, 102, 101, 103, 100, 98, 99, 97
  const rsiCloses = [100, 102, 101, 103, 100, 98, 99, 97];
  const rsiCandles = rsiCloses.map((close, i) =>
    makeCandle({ close, openTime: i * 60000 }),
  );

  test('warmup: first period calls return null, (period+1)-th returns a value', () => {
    const rsi = new RSI({ period: 3 });
    // warmupPeriod = 4 (period + 1)
    const results = feedAll(rsi, rsiCandles.slice(0, 5));
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
    expect(results[3]).not.toBeNull(); // first output at index 3
    expect(results[4]).not.toBeNull();
  });

  test('known value: RSI(3) at index 3 = 80', () => {
    // changes[1..3]: +2, -1, +2 → avgGain=4/3, avgLoss=1/3 → RS=4 → RSI=80
    const rsi = new RSI({ period: 3 });
    let last: number | null = null;
    for (let i = 0; i <= 3; i++) {
      last = rsi.update(rsiCandles[i]!);
    }
    expect(last).toBe(80);
  });

  test('known value: all-up fixture candles → RSI(3) = 100 after warmup', () => {
    // fixture candles all increase, so no losses → RSI = 100
    const rsi = new RSI({ period: 3 });
    let last: number | null = null;
    for (let i = 0; i <= 3; i++) {
      last = rsi.update(fixtures.candles[i]!);
    }
    expect(last).toBe(100);
  });

  test('reset: same candles produce same output after reset()', () => {
    const rsi = new RSI({ period: 3 });
    const first = feedAll(rsi, rsiCandles);
    rsi.reset();
    const second = feedAll(rsi, rsiCandles);
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createRSI({ period: 3 });
    const b = createRSI({ period: 3 });
    for (const c of rsiCandles) {
      a.update(c);
    }
    // b should still be in warmup for first few candles
    expect(b.update(rsiCandles[0]!)).toBeNull();
  });

  test('name and warmupPeriod are correct', () => {
    const rsi = new RSI({ period: 14 });
    expect(rsi.name).toBe('RSI');
    expect(rsi.warmupPeriod).toBe(15); // period + 1
    expect(rsi.config).toEqual({ period: 14 });
  });
});

// ---------------------------------------------------------------------------
// ATR
// ---------------------------------------------------------------------------

describe('ATR', () => {
  test('warmup: first (period-1) calls return null, period-th returns a value', () => {
    const atr = new ATR({ period: 3 });
    const results = feedAll(atr, fixtures.candles.slice(0, 4));
    expect(results[0]).toBeNull();
    expect(results[1]).toBeNull();
    expect(results[2]).not.toBeNull(); // first output at index 2
    expect(results[3]).not.toBeNull();
  });

  test('known value: ATR(3) at index 2 = 80', () => {
    // Candle 0: TR = high-low = 50050-49970 = 80 (no prevClose)
    // Candle 1: TR = max(80, |50060-50020|=40, |49980-50020|=40) = 80
    // Candle 2: TR = max(80, |50070-50030|=40, |49990-50030|=40) = 80
    // ATR(3) = SMA(80, 80, 80) = 80
    const atr = new ATR({ period: 3 });
    let last: number | null = null;
    for (let i = 0; i <= 2; i++) {
      last = atr.update(fixtures.candles[i]!);
    }
    expect(last).toBe(80);
  });

  test('reset: same candles produce same output after reset()', () => {
    const atr = new ATR({ period: 3 });
    const first = feedAll(atr, fixtures.candles.slice(0, 10));
    atr.reset();
    const second = feedAll(atr, fixtures.candles.slice(0, 10));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createATR({ period: 3 });
    const b = createATR({ period: 3 });
    for (let i = 0; i < 5; i++) {
      a.update(fixtures.candles[i]!);
    }
    expect(b.update(fixtures.candles[0]!)).toBeNull();
  });

  test('name and warmupPeriod are correct', () => {
    const atr = new ATR({ period: 14 });
    expect(atr.name).toBe('ATR');
    expect(atr.warmupPeriod).toBe(14);
    expect(atr.config).toEqual({ period: 14 });
  });
});

// ---------------------------------------------------------------------------
// VWAP
// ---------------------------------------------------------------------------

describe('VWAP', () => {
  test('warmup: first call returns a value (warmupPeriod = 1)', () => {
    const vwap = new VWAP({});
    const result = vwap.update(fixtures.candles[0]!);
    expect(result).not.toBeNull();
  });

  test('known value: VWAP at index 0 = typicalPrice of first candle', () => {
    // Candle 0: high=50050, low=49970, close=50020
    // typicalPrice = (50050 + 49970 + 50020) / 3 = 150040 / 3 = 50013.333...
    const vwap = new VWAP({});
    const result = vwap.update(fixtures.candles[0]!);
    const c = fixtures.candles[0]!;
    const expected = (c.high + c.low + c.close) / 3;
    expect(result).toBeCloseTo(expected, 6);
  });

  test('reset: same candles produce same output after reset()', () => {
    const vwap = new VWAP({});
    const first = feedAll(vwap, fixtures.candles.slice(0, 10));
    vwap.reset();
    const second = feedAll(vwap, fixtures.candles.slice(0, 10));
    expect(first).toEqual(second);
  });

  test('factory independence: two instances do not share state', () => {
    const a = createVWAP({});
    const b = createVWAP({});
    // Feed 5 candles into a
    for (let i = 0; i < 5; i++) {
      a.update(fixtures.candles[i]!);
    }
    // b should start fresh and return only first candle's typical price
    const bResult = b.update(fixtures.candles[0]!);
    const c = fixtures.candles[0]!;
    const expected = (c.high + c.low + c.close) / 3;
    expect(bResult).toBeCloseTo(expected, 6);
  });

  test('name and warmupPeriod are correct', () => {
    const vwap = new VWAP({});
    expect(vwap.name).toBe('VWAP');
    expect(vwap.warmupPeriod).toBe(1);
  });

  test('session reset: VWAP resets at UTC midnight boundary', () => {
    const vwap = new VWAP({}); // offset = 0 (UTC midnight)

    // Day 0: one candle before midnight
    const day0Candle = makeCandle({
      close: 100,
      high: 110,
      low: 90,
      volume: 200,
      openTime: 86_400_000 - 60_000, // 23:59 UTC day 0
    });

    // Day 1: first candle just after midnight
    const day1Candle = makeCandle({
      close: 200,
      high: 210,
      low: 190,
      volume: 100,
      openTime: 86_400_000, // 00:00 UTC day 1
    });

    vwap.update(day0Candle);
    const day1Result = vwap.update(day1Candle);

    // After session reset, VWAP should equal the typical price of day1Candle only
    const expectedTypical = (day1Candle.high + day1Candle.low + day1Candle.close) / 3;
    expect(day1Result).toBeCloseTo(expectedTypical, 6);
  });

  test('session reset respects resetOffsetMs', () => {
    const offsetMs = 8 * 3600 * 1000; // UTC+8 offset
    const vwap = new VWAP({ resetOffsetMs: offsetMs });

    // Build two candles spanning the shifted midnight (UTC 16:00 = UTC+8 midnight)
    // Day 0 in UTC+8: just before UTC 16:00
    const candle0 = makeCandle({
      close: 100,
      high: 110,
      low: 90,
      volume: 200,
      openTime: 86_400_000 - 60_000, // 23:59 UTC day 0 = 07:59 UTC+8 day 1 (still day 0 shifted)
    });

    // Day 1 in shifted: openTime such that (openTime - offset) crosses a day boundary
    // (candle0.openTime - offset) day = floor((86400000-60000 - 8*3600000) / 86400000) = floor(-28860000/86400000) = -1
    // For candle1: openTime = 86400000 * 1 + offset = 86400000 + 28800000 = 115200000
    const candle1 = makeCandle({
      close: 200,
      high: 210,
      low: 190,
      volume: 100,
      openTime: 86_400_000 + offsetMs, // (candle1.openTime - offset) / 86400000 = 1
    });

    vwap.update(candle0);
    const result = vwap.update(candle1);

    const expectedTypical = (candle1.high + candle1.low + candle1.close) / 3;
    expect(result).toBeCloseTo(expectedTypical, 6);
  });
});
