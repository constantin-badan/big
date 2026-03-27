import type {
  IExchange,
  AccountBalance,
  Candle,
  FeeStructure,
  OrderBookDiff,
  OrderBookSnapshot,
  OrderRequest,
  OrderResult,
  Position,
  Tick,
  Timeframe,
} from '@trading-bot/types';

export interface MockExchangeConfig {
  candles?: Candle[];
  orderBook?: OrderBookSnapshot;
  fees?: FeeStructure;
  balance?: AccountBalance[];
}

export function createMockExchange(config?: MockExchangeConfig): IExchange {
  const candles = config?.candles ?? [];
  const orderBook = config?.orderBook ?? {
    symbol: '',
    timestamp: 0,
    bids: [],
    asks: [],
  };
  const fees = config?.fees ?? { maker: 0.0002, taker: 0.0004 };
  const balance = config?.balance ?? [];
  let connected = false;

  return {
    async getCandles(): Promise<Candle[]> {
      return candles;
    },
    async getOrderBook(): Promise<OrderBookSnapshot> {
      return orderBook;
    },
    subscribeCandles(
      _symbol: string,
      _timeframe: Timeframe,
      _callback: (candle: Candle) => void,
    ): () => void {
      return () => {};
    },
    subscribeTicks(_symbol: string, _callback: (tick: Tick) => void): () => void {
      return () => {};
    },
    subscribeOrderBookDiff(_symbol: string, _callback: (diff: OrderBookDiff) => void): () => void {
      return () => {};
    },
    async placeOrder(_request: OrderRequest): Promise<OrderResult> {
      throw new Error('MockExchange: placeOrder not configured');
    },
    async cancelOrder(): Promise<void> {},
    async getOpenOrders(): Promise<OrderResult[]> {
      return [];
    },
    async getPosition(): Promise<Position | null> {
      return null;
    },
    async getPositions(): Promise<Position[]> {
      return [];
    },
    async setLeverage(): Promise<void> {},
    async getBalance(): Promise<AccountBalance[]> {
      return balance;
    },
    async getFees(): Promise<FeeStructure> {
      return fees;
    },
    async connect(): Promise<void> {
      connected = true;
    },
    async disconnect(): Promise<void> {
      connected = false;
    },
    isConnected(): boolean {
      return connected;
    },
  };
}
