import type { Candle, Symbol, Timeframe, TradeRecord } from '@trading-bot/types';

export interface ICandleStore {
  insertCandles(symbol: Symbol, timeframe: Timeframe, candles: Candle[]): void;
  getCandles(symbol: Symbol, timeframe: Timeframe, startTime: number, endTime: number): Candle[];
  getEarliestTimestamp(symbol: Symbol, timeframe: Timeframe): number | null;
  getLatestTimestamp(symbol: Symbol, timeframe: Timeframe): number | null;
  getGaps(symbol: Symbol, timeframe: Timeframe): Array<{ from: number; to: number }>;
}

export interface TradeFilter {
  strategyName?: string;
  symbol?: string;
  startTime?: number;
  endTime?: number;
}

export interface ITradeStore {
  insertTrade(strategyName: string, trade: TradeRecord): void;
  getTrades(filter: TradeFilter): TradeRecord[];
}
