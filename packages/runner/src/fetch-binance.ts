/**
 * Standalone Binance Futures candle fetcher.
 * Calls /fapi/v1/klines REST endpoint — no API key or auth required.
 * Returns a CandleFetcher function compatible with syncCandles().
 */
import type { Candle, Symbol, Timeframe } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';
import type { CandleFetcher } from '@trading-bot/storage';

const BINANCE_BASE = 'https://fapi.binance.com';

/** Reinterpret unknown JSON as typed value without `as` assertion. */
function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

const TIMEFRAME_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

interface BinanceKlineRow {
  0: number;  // openTime
  1: string;  // open
  2: string;  // high
  3: string;  // low
  4: string;  // close
  5: string;  // volume
  6: number;  // closeTime
  7: string;  // quoteVolume
  8: number;  // trades
}

export function createBinanceFetcher(): CandleFetcher {
  return async (
    symbol: Symbol,
    timeframe: Timeframe,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<Candle[]> => {
    const interval = TIMEFRAME_MAP[timeframe];
    if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);

    const params = new URLSearchParams({
      symbol: String(symbol),
      interval,
      limit: String(Math.min(limit, 1000)),
    });
    if (startTime !== undefined) params.set('startTime', String(startTime));
    if (endTime !== undefined) params.set('endTime', String(endTime));

    const url = `${BINANCE_BASE}/fapi/v1/klines?${String(params)}`;
    const response = await fetch(url);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Binance API error ${String(response.status)}: ${body}`);
    }

    const rows = unsafeCast<BinanceKlineRow[]>(await response.json());

    return rows.map((row): Candle => ({
      symbol: toSymbol(String(symbol)),
      openTime: row[0],
      closeTime: row[6],
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      quoteVolume: Number(row[7]),
      trades: row[8],
      isClosed: true,
    }));
  };
}
