import type { Candle, Symbol, Timeframe } from '@trading-bot/types';

import type { ICandleStore } from './types';

/**
 * A function that fetches candles from a remote source (e.g., exchange REST API).
 * Same signature as IExchange.getCandles but decoupled from the interface
 * so storage doesn't depend on exchange-client.
 */
export type CandleFetcher = (
  symbol: Symbol,
  timeframe: Timeframe,
  limit: number,
  startTime?: number,
  endTime?: number,
) => Promise<Candle[]>;

export interface SyncRequest {
  symbol: Symbol;
  timeframe: Timeframe;
  startTime: number;
  endTime: number;
}

export interface SyncResult {
  symbol: Symbol;
  timeframe: Timeframe;
  fetchedCandles: number;
  skipped: boolean;
}

const BATCH_SIZE = 1000;

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/**
 * Syncs candle data from a remote source into the local store.
 * Only fetches what's missing — checks stored range and fetches the
 * uncovered head and/or tail. Safe to call repeatedly; INSERT OR IGNORE
 * handles any overlap from re-fetching.
 *
 * Does NOT fill internal gaps (v1). Caller computes the required range
 * including any warmup period for indicators.
 */
export async function syncCandles(
  store: ICandleStore,
  fetch: CandleFetcher,
  requests: SyncRequest[],
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  for (const req of requests) {
    const { symbol, timeframe, startTime, endTime } = req;
    const tfMs = TIMEFRAME_MS[timeframe];
    if (tfMs === undefined) {
      throw new Error(`Unknown timeframe: ${timeframe}`);
    }

    const earliest = store.getEarliestTimestamp(symbol, timeframe);
    const latest = store.getLatestTimestamp(symbol, timeframe);

    // Determine what ranges are missing
    const ranges: Array<{ from: number; to: number }> = [];

    if (earliest === null || latest === null) {
      // No data at all — fetch entire range
      ranges.push({ from: startTime, to: endTime });
    } else {
      // Fetch head: requested start is before stored data
      if (startTime < earliest) {
        ranges.push({ from: startTime, to: earliest });
      }
      // Fetch tail: requested end is after stored data
      if (endTime > latest + tfMs) {
        ranges.push({ from: latest + tfMs, to: endTime });
      }
    }

    if (ranges.length === 0) {
      results.push({ symbol, timeframe, fetchedCandles: 0, skipped: true });
      continue;
    }

    let totalFetched = 0;

    for (const range of ranges) {
      let cursor = range.from;

      while (cursor < range.to) {
        const batch = await fetch(symbol, timeframe, BATCH_SIZE, cursor, range.to);

        if (batch.length === 0) break;

        store.insertCandles(symbol, timeframe, batch);
        totalFetched += batch.length;

        // Advance cursor past the last candle
        const lastCandle = batch[batch.length - 1];
        if (!lastCandle || lastCandle.openTime <= cursor) break; // no forward progress
        cursor = lastCandle.openTime + tfMs;
      }
    }

    results.push({ symbol, timeframe, fetchedCandles: totalFetched, skipped: false });
  }

  return results;
}
