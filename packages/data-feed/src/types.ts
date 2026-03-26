import type { OrderBookSnapshot, Timeframe } from '@trading-bot/types';

export interface IDataFeed {
  start(symbols: string[], timeframes: Timeframe[]): Promise<void>;
  stop(): Promise<void>;
  getOrderBook(symbol: string): OrderBookSnapshot | null;
}
