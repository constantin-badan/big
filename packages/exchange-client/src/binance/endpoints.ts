export interface BinanceEndpoints {
  restBase: string;
  wsStreams: string;
  wsApi: string;
}

export const TESTNET_ENDPOINTS: BinanceEndpoints = {
  restBase: 'https://testnet.binancefuture.com',
  wsStreams: 'wss://stream.binancefuture.com',
  wsApi: 'wss://testnet.binancefuture.com/ws-fapi/v1',
};

export const LIVE_ENDPOINTS: BinanceEndpoints = {
  restBase: 'https://fapi.binance.com',
  wsStreams: 'wss://fstream.binance.com',
  wsApi: 'wss://ws-fapi.binance.com/ws-fapi/v1',
};

export function getEndpoints(type: 'binance-live' | 'binance-testnet'): BinanceEndpoints {
  return type === 'binance-live' ? LIVE_ENDPOINTS : TESTNET_ENDPOINTS;
}

// Timeframe mapping: our Timeframe type → Binance kline interval string
const TIMEFRAME_MAP: Record<string, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

export function toBinanceInterval(timeframe: string): string {
  const interval = TIMEFRAME_MAP[timeframe];
  if (interval === undefined) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
  return interval;
}

export function buildStreamName(symbol: string, stream: string): string {
  return `${symbol.toLowerCase()}@${stream}`;
}

export function buildCombinedStreamUrl(baseUrl: string, streams: string[]): string {
  return `${baseUrl}/stream?streams=${streams.join('/')}`;
}
