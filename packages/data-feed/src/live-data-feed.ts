import type { IExchange } from '@trading-bot/exchange-client';
import type { Candle, IEventBus, OrderBookSnapshot, Symbol, Tick, Timeframe } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import type { IDataFeed } from './types';

/** Key format: "BTCUSDT:1m" */
function backfillKey(symbol: Symbol, timeframe: Timeframe): string {
  return `${symbol}:${timeframe}`;
}

/**
 * LiveDataFeed — semantic layer between live exchange streams and the event bus.
 *
 * Subscribes to IExchange streams, filters candle isClosed, and emits typed events.
 * Handles gap backfill: on exchange:gap events, fetches missing candles via REST,
 * emits them as candle:close, deduplicates by openTime.
 *
 * Semantic difference from ReplayDataFeed:
 * - ReplayDataFeed.start() completing means "all data processed" (run is done)
 * - LiveDataFeed.start() completing means "subscriptions established" (run has begun)
 */
export class LiveDataFeed implements IDataFeed {
  private readonly bus: IEventBus;
  private readonly exchange: IExchange;
  private readonly unsubscribes: Array<() => void> = [];
  private running = false;

  // Gap backfill state per symbol:timeframe
  private readonly backfilling = new Set<string>();
  private readonly backfillBuffer = new Map<string, Candle[]>();

  // Track last seen openTime per symbol:timeframe for dedup
  private readonly lastOpenTime = new Map<string, number>();

  constructor(bus: IEventBus, exchange: IExchange) {
    this.bus = bus;
    this.exchange = exchange;
  }

  async start(symbols: Symbol[], timeframes: Timeframe[]): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Subscribe to candle streams for each symbol × timeframe
    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        const unsub = this.exchange.subscribeCandles(symbol, timeframe, (candle: Candle) => {
          this.handleCandle(symbol, timeframe, candle);
        });
        this.unsubscribes.push(unsub);
      }

      // Subscribe to tick stream for each symbol
      const unsubTick = this.exchange.subscribeTicks(symbol, (tick: Tick) => {
        this.bus.emit('tick', { symbol, tick });
      });
      this.unsubscribes.push(unsubTick);
    }

    // Listen for gap events to trigger backfill
    const handleGap = (data: {
      symbol: string;
      fromTimestamp: number;
      toTimestamp: number;
    }): void => {
      // Backfill for each timeframe on this symbol
      // exchange:gap symbol is plain string from WS reconnection — cast at trust boundary
      const sym = toSymbol(data.symbol);
      for (const tf of timeframes) {
        void this.backfillGap(sym, tf, data.fromTimestamp, data.toTimestamp);
      }
    };
    this.bus.on('exchange:gap', handleGap);
    this.unsubscribes.push(() => this.bus.off('exchange:gap', handleGap));

    // Start the market data WebSocket (if the exchange adapter supports it)
    if (
      'startMarketDataStream' in this.exchange &&
      typeof this.exchange.startMarketDataStream === 'function'
    ) {
      await this.exchange.startMarketDataStream();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes.length = 0;
    this.backfilling.clear();
    this.backfillBuffer.clear();
  }

  getOrderBook(_symbol: Symbol): OrderBookSnapshot | null {
    return null;
  }

  private handleCandle(symbol: Symbol, timeframe: Timeframe, candle: Candle): void {
    if (!this.running) return;

    const key = backfillKey(symbol, timeframe);

    // If backfilling, buffer live candles instead of emitting
    if (this.backfilling.has(key)) {
      let buffer = this.backfillBuffer.get(key);
      if (!buffer) {
        buffer = [];
        this.backfillBuffer.set(key, buffer);
      }
      buffer.push(candle);
      return;
    }

    if (candle.isClosed) {
      // Dedup: skip if we already emitted this openTime
      const lastOt = this.lastOpenTime.get(key);
      if (lastOt !== undefined && candle.openTime <= lastOt) return;
      this.lastOpenTime.set(key, candle.openTime);

      this.bus.emit('candle:close', { symbol, timeframe, candle });
    } else {
      this.bus.emit('candle:update', { symbol, timeframe, candle });
    }
  }

  private async backfillGap(
    symbol: Symbol,
    timeframe: Timeframe,
    fromTimestamp: number,
    toTimestamp: number,
  ): Promise<void> {
    const key = backfillKey(symbol, timeframe);

    // Skip if already backfilling this key (prevent concurrent backfills)
    if (this.backfilling.has(key)) return;

    // Set backfilling flag — live candles will be buffered
    this.backfilling.add(key);

    try {
      // Paginate: fetch candles in batches until the full gap is covered
      let cursor = fromTimestamp;
      while (cursor < toTimestamp) {
        const candles = await this.exchange.getCandles(symbol, timeframe, 1000);

        // Filter to the remaining gap window and only closed candles
        const gapCandles = candles.filter(
          (c) => c.openTime >= cursor && c.openTime < toTimestamp && c.isClosed,
        );

        if (gapCandles.length === 0) break; // no more data available

        // Emit backfilled candles as candle:close
        for (const candle of gapCandles) {
          const lastOt = this.lastOpenTime.get(key);
          if (lastOt !== undefined && candle.openTime <= lastOt) continue;
          this.lastOpenTime.set(key, candle.openTime);
          this.bus.emit('candle:close', { symbol, timeframe, candle });
        }

        // Advance cursor past the last candle we received
        const lastCandle = gapCandles[gapCandles.length - 1];
        if (!lastCandle || lastCandle.openTime <= cursor) break; // no forward progress
        cursor = lastCandle.openTime + 1;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.bus.emit('error', {
        source: 'data-feed',
        error,
        context: { action: 'backfill', symbol, timeframe, fromTimestamp, toTimestamp },
      });
    }

    // Flush buffered live candles BEFORE clearing flag so new arrivals are still buffered
    const buffered = this.backfillBuffer.get(key);
    this.backfillBuffer.delete(key);

    if (buffered) {
      for (const candle of buffered) {
        // Re-check dedup inline (can't call handleCandle — flag is still set)
        if (!this.running) continue;
        if (candle.isClosed) {
          const lastOt = this.lastOpenTime.get(key);
          if (lastOt !== undefined && candle.openTime <= lastOt) continue;
          this.lastOpenTime.set(key, candle.openTime);
          this.bus.emit('candle:close', { symbol, timeframe, candle });
        } else {
          this.bus.emit('candle:update', { symbol, timeframe, candle });
        }
      }
    }

    // Clear backfilling flag AFTER flush is complete
    this.backfilling.delete(key);
  }
}
