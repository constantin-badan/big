import type { Candle, Timeframe, TradeRecord } from '@trading-bot/types';

export interface ICandleStore {
  insertCandles(symbol: string, timeframe: Timeframe, candles: Candle[]): void;
  getCandles(symbol: string, timeframe: Timeframe, startTime: number, endTime: number): Candle[];
  getLatestTimestamp(symbol: string, timeframe: Timeframe): number | null;
  getGaps(
    symbol: string,
    timeframe: Timeframe,
  ): Array<{ from: number; to: number }>;
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
