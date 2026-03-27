import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'node:fs';

import type { Candle, TradeRecord } from '@trading-bot/types';

import { createStorage } from '../storage';
import type { ICandleStore, ITradeStore } from '../types';

const TEST_DB = ':memory:';
const BASE_TIME = 1700000000000;

function makeCandle(index: number): Candle {
  const open = 50000 + index * 10;
  return {
    openTime: BASE_TIME + index * 60_000,
    closeTime: BASE_TIME + (index + 1) * 60_000 - 1,
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

function makeTrade(id: string, overrides?: Partial<TradeRecord>): TradeRecord {
  return {
    id,
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 50000,
    exitPrice: 50500,
    quantity: 0.1,
    entryTime: BASE_TIME,
    exitTime: BASE_TIME + 3600_000,
    pnl: 50,
    fees: 2,
    slippage: 0.5,
    holdTimeMs: 3600_000,
    exitReason: 'TAKE_PROFIT',
    metadata: { indicator: 'ema_cross' },
    ...overrides,
  };
}

let candles: ICandleStore;
let trades: ITradeStore;
let close: () => void;

beforeEach(() => {
  const storage = createStorage(TEST_DB);
  candles = storage.candles;
  trades = storage.trades;
  close = storage.close;
});

afterEach(() => {
  close();
});

// === CandleStore tests ===

describe('CandleStore', () => {
  test('insert and retrieve candles', () => {
    const data = [makeCandle(0), makeCandle(1), makeCandle(2)];
    candles.insertCandles('BTCUSDT', '1m', data);

    const result = candles.getCandles('BTCUSDT', '1m', BASE_TIME, BASE_TIME + 300_000);
    expect(result).toHaveLength(3);
    expect(result[0]!.openTime).toBe(data[0]!.openTime);
    expect(result[0]!.close).toBe(data[0]!.close);
    expect(result[0]!.isClosed).toBe(true);
  });

  test('deduplicates by primary key (INSERT OR IGNORE)', () => {
    const candle = makeCandle(0);
    candles.insertCandles('BTCUSDT', '1m', [candle]);
    candles.insertCandles('BTCUSDT', '1m', [candle]); // duplicate

    const result = candles.getCandles('BTCUSDT', '1m', BASE_TIME, BASE_TIME + 60_000);
    expect(result).toHaveLength(1);
  });

  test('filters by symbol and timeframe', () => {
    candles.insertCandles('BTCUSDT', '1m', [makeCandle(0)]);
    candles.insertCandles('ETHUSDT', '1m', [makeCandle(0)]);
    candles.insertCandles('BTCUSDT', '5m', [makeCandle(0)]);

    expect(candles.getCandles('BTCUSDT', '1m', 0, BASE_TIME + 300_000)).toHaveLength(1);
    expect(candles.getCandles('ETHUSDT', '1m', 0, BASE_TIME + 300_000)).toHaveLength(1);
    expect(candles.getCandles('BTCUSDT', '5m', 0, BASE_TIME + 300_000)).toHaveLength(1);
    expect(candles.getCandles('XRPUSDT', '1m', 0, BASE_TIME + 300_000)).toHaveLength(0);
  });

  test('filters by time range', () => {
    const data = Array.from({ length: 10 }, (_, i) => makeCandle(i));
    candles.insertCandles('BTCUSDT', '1m', data);

    // Get candles 3-6 (indices)
    const start = BASE_TIME + 3 * 60_000;
    const end = BASE_TIME + 6 * 60_000;
    const result = candles.getCandles('BTCUSDT', '1m', start, end);
    expect(result).toHaveLength(4); // indices 3,4,5,6
  });

  test('returns candles in chronological order', () => {
    // Insert out of order
    candles.insertCandles('BTCUSDT', '1m', [makeCandle(5), makeCandle(2), makeCandle(8)]);

    const result = candles.getCandles('BTCUSDT', '1m', 0, BASE_TIME + 600_000);
    expect(result).toHaveLength(3);
    expect(result[0]!.openTime).toBeLessThan(result[1]!.openTime);
    expect(result[1]!.openTime).toBeLessThan(result[2]!.openTime);
  });

  test('getLatestTimestamp returns latest openTime', () => {
    candles.insertCandles('BTCUSDT', '1m', [makeCandle(0), makeCandle(5), makeCandle(3)]);

    const latest = candles.getLatestTimestamp('BTCUSDT', '1m');
    expect(latest).toBe(makeCandle(5).openTime);
  });

  test('getLatestTimestamp returns null for empty store', () => {
    expect(candles.getLatestTimestamp('BTCUSDT', '1m')).toBeNull();
  });

  test('getGaps detects missing candles', () => {
    // Insert candles 0,1,2, skip 3,4, then 5,6
    const data = [0, 1, 2, 5, 6].map((i) => makeCandle(i));
    candles.insertCandles('BTCUSDT', '1m', data);

    const gaps = candles.getGaps('BTCUSDT', '1m');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.from).toBe(makeCandle(2).openTime);
    expect(gaps[0]!.to).toBe(makeCandle(5).openTime);
  });

  test('getGaps returns empty for contiguous candles', () => {
    const data = Array.from({ length: 5 }, (_, i) => makeCandle(i));
    candles.insertCandles('BTCUSDT', '1m', data);

    expect(candles.getGaps('BTCUSDT', '1m')).toHaveLength(0);
  });

  test('getGaps returns empty for fewer than 2 candles', () => {
    candles.insertCandles('BTCUSDT', '1m', [makeCandle(0)]);
    expect(candles.getGaps('BTCUSDT', '1m')).toHaveLength(0);
  });

  test('handles large batch inserts', () => {
    const data = Array.from({ length: 1000 }, (_, i) => makeCandle(i));
    candles.insertCandles('BTCUSDT', '1m', data);

    const result = candles.getCandles('BTCUSDT', '1m', 0, BASE_TIME + 1000 * 60_000);
    expect(result).toHaveLength(1000);
  });

  test('preserves all candle fields', () => {
    const original = makeCandle(0);
    candles.insertCandles('BTCUSDT', '1m', [original]);

    const result = candles.getCandles('BTCUSDT', '1m', BASE_TIME, BASE_TIME + 60_000);
    expect(result).toHaveLength(1);
    const stored = result[0]!;
    expect(stored.openTime).toBe(original.openTime);
    expect(stored.closeTime).toBe(original.closeTime);
    expect(stored.open).toBe(original.open);
    expect(stored.high).toBe(original.high);
    expect(stored.low).toBe(original.low);
    expect(stored.close).toBe(original.close);
    expect(stored.volume).toBe(original.volume);
    expect(stored.quoteVolume).toBe(original.quoteVolume);
    expect(stored.trades).toBe(original.trades);
  });
});

// === TradeStore tests ===

describe('TradeStore', () => {
  test('insert and retrieve trades', () => {
    const trade = makeTrade('t1');
    trades.insertTrade('ema-cross', trade);

    const result = trades.getTrades({});
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('t1');
    expect(result[0]!.pnl).toBe(50);
  });

  test('filters by strategyName', () => {
    trades.insertTrade('ema-cross', makeTrade('t1'));
    trades.insertTrade('rsi-divergence', makeTrade('t2'));

    const result = trades.getTrades({ strategyName: 'ema-cross' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('t1');
  });

  test('filters by symbol', () => {
    trades.insertTrade('s1', makeTrade('t1', { symbol: 'BTCUSDT' }));
    trades.insertTrade('s1', makeTrade('t2', { symbol: 'ETHUSDT' }));

    const result = trades.getTrades({ symbol: 'ETHUSDT' });
    expect(result).toHaveLength(1);
    expect(result[0]!.symbol).toBe('ETHUSDT');
  });

  test('filters by time range', () => {
    trades.insertTrade('s1', makeTrade('t1', { exitTime: 1000 }));
    trades.insertTrade('s1', makeTrade('t2', { exitTime: 2000 }));
    trades.insertTrade('s1', makeTrade('t3', { exitTime: 3000 }));

    const result = trades.getTrades({ startTime: 1500, endTime: 2500 });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('t2');
  });

  test('combines multiple filters', () => {
    trades.insertTrade('s1', makeTrade('t1', { symbol: 'BTCUSDT', exitTime: 1000 }));
    trades.insertTrade('s1', makeTrade('t2', { symbol: 'ETHUSDT', exitTime: 2000 }));
    trades.insertTrade('s2', makeTrade('t3', { symbol: 'BTCUSDT', exitTime: 3000 }));

    const result = trades.getTrades({ strategyName: 's1', symbol: 'BTCUSDT' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('t1');
  });

  test('returns trades in chronological order', () => {
    trades.insertTrade('s1', makeTrade('t3', { exitTime: 3000 }));
    trades.insertTrade('s1', makeTrade('t1', { exitTime: 1000 }));
    trades.insertTrade('s1', makeTrade('t2', { exitTime: 2000 }));

    const result = trades.getTrades({});
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('t1');
    expect(result[1]!.id).toBe('t2');
    expect(result[2]!.id).toBe('t3');
  });

  test('preserves metadata as JSON', () => {
    const trade = makeTrade('t1', { metadata: { ema_fast: 12, ema_slow: 26, reason: 'cross' } });
    trades.insertTrade('s1', trade);

    const result = trades.getTrades({});
    expect(result[0]!.metadata).toEqual({ ema_fast: 12, ema_slow: 26, reason: 'cross' });
  });

  test('handles empty metadata', () => {
    const trade = makeTrade('t1', { metadata: {} });
    trades.insertTrade('s1', trade);

    const result = trades.getTrades({});
    expect(result[0]!.metadata).toEqual({});
  });

  test('preserves all trade fields', () => {
    const original = makeTrade('t1');
    trades.insertTrade('s1', original);

    const result = trades.getTrades({});
    const stored = result[0]!;
    expect(stored.id).toBe(original.id);
    expect(stored.symbol).toBe(original.symbol);
    expect(stored.side).toBe(original.side);
    expect(stored.entryPrice).toBe(original.entryPrice);
    expect(stored.exitPrice).toBe(original.exitPrice);
    expect(stored.quantity).toBe(original.quantity);
    expect(stored.entryTime).toBe(original.entryTime);
    expect(stored.exitTime).toBe(original.exitTime);
    expect(stored.pnl).toBe(original.pnl);
    expect(stored.fees).toBe(original.fees);
    expect(stored.slippage).toBe(original.slippage);
    expect(stored.holdTimeMs).toBe(original.holdTimeMs);
    expect(stored.exitReason).toBe(original.exitReason);
  });

  test('empty filter returns all trades', () => {
    trades.insertTrade('s1', makeTrade('t1'));
    trades.insertTrade('s2', makeTrade('t2'));
    trades.insertTrade('s3', makeTrade('t3'));

    expect(trades.getTrades({})).toHaveLength(3);
  });
});

// === createStorage tests ===

describe('createStorage', () => {
  test('creates storage with candles and trades stores', () => {
    const storage = createStorage(':memory:');
    expect(storage.candles).toBeDefined();
    expect(storage.trades).toBeDefined();
    expect(storage.close).toBeTypeOf('function');
    storage.close();
  });

  test('file-based storage persists across reopen', () => {
    const path = '/tmp/test-trading-storage.db';
    try {
      // Write
      const s1 = createStorage(path);
      s1.candles.insertCandles('BTCUSDT', '1m', [makeCandle(0)]);
      s1.trades.insertTrade('test', makeTrade('t1'));
      s1.close();

      // Read
      const s2 = createStorage(path);
      expect(s2.candles.getCandles('BTCUSDT', '1m', 0, BASE_TIME + 60_000)).toHaveLength(1);
      expect(s2.trades.getTrades({})).toHaveLength(1);
      s2.close();
    } finally {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(`${path}-wal`);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(`${path}-shm`);
      } catch {
        /* ignore */
      }
    }
  });
});
