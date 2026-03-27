import type {
  Candle,
  OrderBookDiff,
  OrderBookSnapshot,
  OrderResult,
  OrderSide,
  OrderStatus,
  OrderType,
  Tick,
} from '@trading-bot/types';

import { jsonParse, numPair, unsafeCast } from './unsafe-cast';

// === Combined stream message parsing ===

export interface CombinedStreamMessage {
  stream: string;
  data: unknown;
}

export function parseCombinedStreamMessage(raw: string): CombinedStreamMessage {
  const msg = jsonParse<{ stream?: string; data?: unknown }>(raw);
  if (typeof msg.stream !== 'string' || msg.data === undefined) {
    throw new Error(`Invalid combined stream message: missing stream or data field`);
  }
  return { stream: msg.stream, data: msg.data };
}

// === Kline (candle) parsing ===

interface BinanceKline {
  t: number; // open time
  T: number; // close time
  o: string; // open
  h: string; // high
  l: string; // low
  c: string; // close
  v: string; // volume
  q: string; // quote volume
  n: number; // number of trades
  x: boolean; // is closed
}

interface BinanceKlineEvent {
  e: string; // event type
  k: BinanceKline;
}

export function parseKlineMessage(data: unknown): Candle {
  const event = unsafeCast<BinanceKlineEvent>(data);
  const k = event.k;
  return {
    openTime: k.t,
    closeTime: k.T,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    quoteVolume: Number(k.q),
    trades: k.n,
    isClosed: k.x,
  };
}

// === AggTrade (tick) parsing ===

interface BinanceAggTrade {
  e: string;
  s: string; // symbol
  p: string; // price
  q: string; // quantity
  T: number; // trade time
  m: boolean; // is buyer maker
}

export function parseAggTradeMessage(data: unknown): Tick {
  const event = unsafeCast<BinanceAggTrade>(data);
  return {
    symbol: event.s,
    price: Number(event.p),
    quantity: Number(event.q),
    timestamp: event.T,
    isBuyerMaker: event.m,
  };
}

// === Depth (order book diff) parsing ===

interface BinanceDepthEvent {
  e: string;
  s: string; // symbol
  T: number; // transaction time
  b: [string, string][]; // bids [price, qty]
  a: [string, string][]; // asks [price, qty]
  U: number; // first update ID
  u: number; // final update ID
}

export function parseDepthMessage(data: unknown): OrderBookDiff {
  const event = unsafeCast<BinanceDepthEvent>(data);
  return {
    symbol: event.s,
    timestamp: event.T,
    bids: event.b.map(([p, q]) => numPair(Number(p), Number(q))),
    asks: event.a.map(([p, q]) => numPair(Number(p), Number(q))),
    firstUpdateId: event.U,
    lastUpdateId: event.u,
  };
}

// === REST response parsing ===

interface BinanceRestCandle {
  0: number; // open time
  1: string; // open
  2: string; // high
  3: string; // low
  4: string; // close
  5: string; // volume
  6: number; // close time
  7: string; // quote volume
  8: number; // number of trades
}

export function parseRestCandles(data: unknown): Candle[] {
  const rows = unsafeCast<BinanceRestCandle[]>(data);
  return rows.map((row) => ({
    openTime: row[0],
    closeTime: row[6],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    quoteVolume: Number(row[7]),
    trades: row[8],
    isClosed: true,
  }));
}

export function parseRestOrderBook(data: unknown, symbol: string): OrderBookSnapshot {
  const book = unsafeCast<{
    T: number;
    bids: [string, string][];
    asks: [string, string][];
  }>(data);
  return {
    symbol,
    timestamp: book.T,
    bids: book.bids.map(([p, q]) => numPair(Number(p), Number(q))),
    asks: book.asks.map(([p, q]) => numPair(Number(p), Number(q))),
  };
}

// === Order/Trade update parsing ===

const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  NEW: 'NEW',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
};

const ORDER_SIDE_MAP: Record<string, OrderSide> = {
  BUY: 'BUY',
  SELL: 'SELL',
};

const ORDER_TYPE_MAP: Record<string, OrderType> = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOP_MARKET: 'STOP_MARKET',
  TAKE_PROFIT_MARKET: 'TAKE_PROFIT_MARKET',
};

interface BinanceOrderTradeUpdate {
  e: 'ORDER_TRADE_UPDATE';
  T: number; // transaction time
  o: {
    s: string; // symbol
    c: string; // client order ID
    S: string; // side
    o: string; // order type
    q: string; // original quantity
    p: string; // original price
    ap: string; // average price
    X: string; // order status
    i: number; // order ID
    z: string; // order filled accumulated quantity
    n: string; // commission
    N: string; // commission asset
    T: number; // order trade time
  };
}

export function parseOrderTradeUpdate(data: unknown): OrderResult {
  const event = unsafeCast<BinanceOrderTradeUpdate>(data);
  const o = event.o;
  return {
    orderId: String(o.i),
    clientOrderId: o.c,
    symbol: o.s,
    side: ORDER_SIDE_MAP[o.S] ?? 'BUY',
    type: ORDER_TYPE_MAP[o.o] ?? 'MARKET',
    status: ORDER_STATUS_MAP[o.X] ?? 'NEW',
    price: Number(o.p),
    avgPrice: Number(o.ap),
    quantity: Number(o.q),
    filledQuantity: Number(o.z),
    commission: Number(o.n),
    commissionAsset: o.N,
    timestamp: o.T,
    latencyMs: 0,
  };
}

interface BinanceAlgoUpdate {
  e: 'ALGO_UPDATE';
  T: number;
  o: {
    s: string;
    c: string;
    S: string;
    o: string;
    q: string;
    p: string;
    ap: string;
    X: string;
    i: number;
    z: string;
    n: string;
    N: string;
    T: number;
  };
}

export function parseAlgoUpdate(data: unknown): OrderResult {
  const event = unsafeCast<BinanceAlgoUpdate>(data);
  const o = event.o;
  return {
    orderId: String(o.i),
    clientOrderId: o.c,
    symbol: o.s,
    side: ORDER_SIDE_MAP[o.S] ?? 'BUY',
    type: ORDER_TYPE_MAP[o.o] ?? 'STOP_MARKET',
    status: ORDER_STATUS_MAP[o.X] ?? 'NEW',
    price: Number(o.p),
    avgPrice: Number(o.ap),
    quantity: Number(o.q),
    filledQuantity: Number(o.z),
    commission: Number(o.n),
    commissionAsset: o.N,
    timestamp: o.T,
    latencyMs: 0,
  };
}

// === WS API response parsing ===

interface BinanceWsApiOrderResponse {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  timeInForce: string;
  updateTime: number;
}

export function parseWsApiOrderResponse(data: unknown, requestTime: number): OrderResult {
  const r = unsafeCast<BinanceWsApiOrderResponse>(data);
  return {
    orderId: String(r.orderId),
    clientOrderId: r.clientOrderId,
    symbol: r.symbol,
    side: ORDER_SIDE_MAP[r.side] ?? 'BUY',
    type: ORDER_TYPE_MAP[r.type] ?? 'MARKET',
    status: ORDER_STATUS_MAP[r.status] ?? 'NEW',
    price: Number(r.price),
    avgPrice: Number(r.avgPrice),
    quantity: Number(r.origQty),
    filledQuantity: Number(r.executedQty),
    commission: 0, // Not in ack response — comes via user data stream
    commissionAsset: 'USDT',
    timestamp: r.updateTime,
    latencyMs: Date.now() - requestTime,
  };
}

// === Order request building ===

export type OrderApiMethod = 'order.place' | 'algoOrder.place';

export function routeOrderType(type: OrderType): OrderApiMethod {
  switch (type) {
    case 'MARKET':
    case 'LIMIT':
      return 'order.place';
    case 'STOP_MARKET':
    case 'TAKE_PROFIT_MARKET':
      return 'algoOrder.place';
  }
}

export function buildOrderParams(
  request: import('@trading-bot/types').OrderRequest,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    symbol: request.symbol,
    side: request.side,
    type: request.type,
    quantity: request.quantity,
  };

  if (request.type === 'MARKET') {
    params.newOrderRespType = 'RESULT';
  }

  if (request.price !== undefined) {
    params.price = request.price;
  }

  if (request.stopPrice !== undefined) {
    params.stopPrice = request.stopPrice;
  }

  if (request.timeInForce !== undefined) {
    params.timeInForce = request.timeInForce;
  } else if (request.type === 'LIMIT') {
    params.timeInForce = 'GTC';
  }

  if (request.reduceOnly === true) {
    params.reduceOnly = 'true';
  }

  if (request.clientOrderId !== undefined) {
    params.newClientOrderId = request.clientOrderId;
  }

  return params;
}
