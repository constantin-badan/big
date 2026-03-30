import type { Symbol } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

const BINANCE_FUTURES_TICKER_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';

const FALLBACK_SYMBOLS: Symbol[] = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT',
].map(s => toSymbol(s));

/** Reinterpret unknown JSON as typed value without `as` assertion. */
function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

interface TickerEntry {
  symbol: string;
  quoteVolume: string;
}

export async function fetchTopSymbols(count: number): Promise<Symbol[]> {
  try {
    const response = await fetch(BINANCE_FUTURES_TICKER_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const tickers = unsafeCast<TickerEntry[]>(await response.json());
    return tickers
      .filter(t => t.symbol.endsWith('USDT'))
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, count)
      .map(t => toSymbol(t.symbol));
  } catch {
    return FALLBACK_SYMBOLS.slice(0, count);
  }
}
