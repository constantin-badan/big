import type { IEventBus } from '@trading-bot/event-bus';
import type { Candle, OrderBookSnapshot, Symbol, Timeframe } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import type { IDataFeed } from './types';

// Map key format: "${symbol}:${timeframe}" — e.g. "BTCUSDT:1m"

const TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

const TIMEFRAME_SET: Set<string> = new Set(TIMEFRAMES);

function isTimeframe(value: string): value is Timeframe {
  return TIMEFRAME_SET.has(value);
}

interface IndexedCandle {
  symbol: Symbol;
  timeframe: Timeframe;
  candle: Candle;
}

function parseKey(key: string): { symbol: Symbol; timeframe: Timeframe } | null {
  const lastColon = key.lastIndexOf(':');
  if (lastColon === -1) return null;
  const symbol = toSymbol(key.slice(0, lastColon));
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

  start(symbols: Symbol[], timeframes: Timeframe[]): Promise<void> {
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

    // Check for candle gaps within each symbol:timeframe group
    this.validateCandleContinuity(indexed);

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

  private validateCandleContinuity(indexed: IndexedCandle[]): void {
    // Group candles by symbol:timeframe
    const groups = new Map<string, IndexedCandle[]>();
    for (const item of indexed) {
      const key = `${item.symbol}:${item.timeframe}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(item);
    }

    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const parts = key.split(':');
      const symbol = parts[0] ?? '';
      const tf = parts[1] ?? '';
      if (!isTimeframe(tf)) continue;
      const expectedInterval = TIMEFRAME_MS[tf];

      for (let i = 1; i < group.length; i++) {
        const prev = group[i - 1]!;
        const curr = group[i]!;
        const actualGap = curr.candle.openTime - prev.candle.openTime;
        if (actualGap !== expectedInterval) {
          this.bus.emit('error', {
            source: 'data-feed',
            error: new Error(
              `Candle gap detected for ${symbol}:${tf}: expected ${expectedInterval}ms between candles, got ${actualGap}ms at openTime ${curr.candle.openTime}`,
            ),
            context: { symbol, timeframe: tf, expectedGap: expectedInterval, actualGap },
          });
        }
      }
    }
  }

  getOrderBook(_symbol: Symbol): OrderBookSnapshot | null {
    return null;
  }
}
