import type { OrderBookSnapshot, Symbol, Timeframe } from '@trading-bot/types';

export interface IDataFeed {
  start(symbols: Symbol[], timeframes: Timeframe[]): Promise<void>;
  stop(): Promise<void>;
  getOrderBook(symbol: Symbol): OrderBookSnapshot | null;
}
