#!/usr/bin/env bun
/**
 * Thin wrapper — delegates to @trading-bot/runner for candle sync.
 * Usage: bun run scripts/sync.ts
 */
import { toSymbol } from '@trading-bot/types';
import type { Symbol, Timeframe } from '@trading-bot/types';
import { createStorage, syncCandles } from '@trading-bot/storage';
import type { SyncRequest } from '@trading-bot/storage';
import { createBinanceFetcher } from '@trading-bot/runner';

const DB_PATH = './data/candles.db';

const SYMBOLS: Symbol[] = [
  toSymbol('BTCUSDT'),
  toSymbol('ETHUSDT'),
  toSymbol('SOLUSDT'),
  toSymbol('BNBUSDT'),
];

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h'];
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const endTime = Date.now();
  const startTime = endTime - LOOKBACK_MS;

  console.log(`Syncing candles to ${DB_PATH}`);
  console.log(`Period: ${new Date(startTime).toISOString()} -> ${new Date(endTime).toISOString()}`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Timeframes: ${TIMEFRAMES.join(', ')}`);
  console.log('');

  const { candles: store } = createStorage(DB_PATH);
  const fetcher = createBinanceFetcher();

  const requests: SyncRequest[] = SYMBOLS.flatMap((symbol) =>
    TIMEFRAMES.map((timeframe): SyncRequest => ({
      symbol,
      timeframe,
      startTime,
      endTime,
    })),
  );

  console.log(`${String(requests.length)} sync requests (${String(SYMBOLS.length)} symbols x ${String(TIMEFRAMES.length)} timeframes)`);
  console.log('');

  const results = await syncCandles(store, fetcher, requests);

  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${String(r.symbol)} ${r.timeframe}: up to date (skipped)`);
    } else {
      console.log(`  ${String(r.symbol)} ${r.timeframe}: fetched ${String(r.fetchedCandles)} candles`);
    }
  }

  const totalFetched = results.reduce((sum, r) => sum + r.fetchedCandles, 0);
  console.log('');
  console.log(`Done. ${String(totalFetched)} candles fetched total.`);
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
