import type { IEventBus } from '@trading-bot/event-bus';
import type { Candle, OrderBookSnapshot, Timeframe } from '@trading-bot/types';

import type { IDataFeed } from './types';

// Map key format: "${symbol}:${timeframe}" — e.g. "BTCUSDT:1m"

const TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

const TIMEFRAME_SET: Set<string> = new Set(TIMEFRAMES);

function isTimeframe(value: string): value is Timeframe {
  return TIMEFRAME_SET.has(value);
}

interface IndexedCandle {
  symbol: string;
  timeframe: Timeframe;
  candle: Candle;
}

function parseKey(key: string): { symbol: string; timeframe: Timeframe } | null {
  const lastColon = key.lastIndexOf(':');
  if (lastColon === -1) return null;
  const symbol = key.slice(0, lastColon);
  const tf = key.slice(lastColon + 1);
  if (!isTimeframe(tf)) return null;
  return { symbol, timeframe: tf };
}

export class ReplayDataFeed implements IDataFeed {
  private readonly bus: IEventBus;
  private readonly candles: Map<string, Candle[]>;
  private running = false;

  constructor(bus: IEventBus, candles: Map<string, Candle[]>) {
    this.bus = bus;
    this.candles = candles;
  }

  start(symbols: string[], timeframes: Timeframe[]): Promise<void> {
    const indexed: IndexedCandle[] = [];

    for (const [key, arr] of this.candles) {
      const parsed = parseKey(key);
      if (parsed === null) continue;
      const { symbol, timeframe } = parsed;
      if (symbols.length > 0 && !symbols.includes(symbol)) continue;
      if (timeframes.length > 0 && !timeframes.includes(timeframe)) continue;
      for (const candle of arr) {
        indexed.push({ symbol, timeframe, candle });
      }
    }

    // Stable sort by openTime ascending; ties preserve insertion order
    indexed.sort((a, b) => a.candle.openTime - b.candle.openTime);

    this.running = true;

    for (const { symbol, timeframe, candle } of indexed) {
      if (!this.running) break;
      this.bus.emit('candle:close', { symbol, timeframe, candle });
    }

    this.running = false;

    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    return Promise.resolve();
  }

  getOrderBook(_symbol: string): OrderBookSnapshot | null {
    return null;
  }
}
