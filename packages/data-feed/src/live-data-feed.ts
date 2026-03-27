import type { IEventBus } from '@trading-bot/event-bus';
import type { IExchange } from '@trading-bot/exchange-client';
import type { Candle, OrderBookSnapshot, Tick, Timeframe } from '@trading-bot/types';

import type { IDataFeed } from './types';

/**
 * LiveDataFeed — semantic layer between live exchange streams and the event bus.
 *
 * Subscribes to IExchange streams, filters candle isClosed, and emits typed events.
 * For Phase 3a-minimal: no order book maintenance, no gap backfill.
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

  constructor(bus: IEventBus, exchange: IExchange) {
    this.bus = bus;
    this.exchange = exchange;
  }

  async start(symbols: string[], timeframes: Timeframe[]): Promise<void> {
    if (this.running) return;

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

    // Start the market data WebSocket (if the exchange adapter supports it)
    if ('startMarketDataStream' in this.exchange &&
        typeof this.exchange.startMarketDataStream === 'function') {
      await this.exchange.startMarketDataStream();
    }

    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes.length = 0;
  }

  getOrderBook(_symbol: string): OrderBookSnapshot | null {
    // Phase 3a-minimal: no order book maintenance
    return null;
  }

  private handleCandle(symbol: string, timeframe: Timeframe, candle: Candle): void {
    if (!this.running) return;

    if (candle.isClosed) {
      this.bus.emit('candle:close', { symbol, timeframe, candle });
    } else {
      this.bus.emit('candle:update', { symbol, timeframe, candle });
    }
  }
}
