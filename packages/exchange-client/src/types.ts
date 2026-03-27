import type {
  AccountBalance,
  Candle,
  ExchangeConfig,
  FeeStructure,
  OrderBookDiff,
  OrderBookSnapshot,
  OrderRequest,
  OrderResult,
  Position,
  Tick,
  Timeframe,
} from '@trading-bot/types';

export interface IExchange {
  getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBookSnapshot>;

  subscribeCandles(
    symbol: string,
    timeframe: Timeframe,
    callback: (candle: Candle) => void,
  ): () => void;
  subscribeTicks(symbol: string, callback: (tick: Tick) => void): () => void;
  subscribeOrderBookDiff(symbol: string, callback: (diff: OrderBookDiff) => void): () => void;

  placeOrder(request: OrderRequest): Promise<OrderResult>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  getOpenOrders(symbol: string): Promise<OrderResult[]>;

  getPosition(symbol: string): Promise<Position | null>;
  getPositions(): Promise<Position[]>;
  setLeverage(symbol: string, leverage: number): Promise<void>;

  getBalance(): Promise<AccountBalance[]>;
  getFees(symbol: string): Promise<FeeStructure>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

export type { ExchangeConfig };
