/**
 * Zod validation schemas for money-boundary Binance API responses.
 *
 * Only responses where a malformed field can produce wrong position sizes
 * or missed fills are validated here. Market data (klines, ticks, depth)
 * stays unchecked for performance.
 */

import { z } from 'zod';

// ORDER_TRADE_UPDATE event (user data stream — fills)
export const OrderTradeUpdateSchema = z.object({
  e: z.literal('ORDER_TRADE_UPDATE'),
  T: z.number(),
  o: z.object({
    s: z.string(), // symbol
    c: z.string(), // client order ID
    S: z.string(), // side
    o: z.string(), // order type
    q: z.string(), // original quantity
    p: z.string(), // original price
    ap: z.string(), // average price
    X: z.string(), // order status
    i: z.number(), // order ID
    z: z.string(), // filled accumulated quantity
    n: z.string(), // commission
    N: z.string(), // commission asset
    T: z.number(), // order trade time
  }),
});

// ALGO_UPDATE event (conditional orders — same shape as ORDER_TRADE_UPDATE)
export const AlgoUpdateSchema = z.object({
  e: z.literal('ALGO_UPDATE'),
  T: z.number(),
  o: z.object({
    s: z.string(),
    c: z.string(),
    S: z.string(),
    o: z.string(),
    q: z.string(),
    p: z.string(),
    ap: z.string(),
    X: z.string(),
    i: z.number(),
    z: z.string(),
    n: z.string(),
    N: z.string(),
    T: z.number(),
  }),
});

// WS API order response (synchronous ack)
export const WsApiOrderResponseSchema = z.object({
  orderId: z.number(),
  clientOrderId: z.string(),
  symbol: z.string(),
  side: z.string(),
  type: z.string(),
  status: z.string(),
  price: z.string(),
  avgPrice: z.string(),
  origQty: z.string(),
  executedQty: z.string(),
  cumQuote: z.string(),
  timeInForce: z.string(),
  updateTime: z.number(),
});

// REST position risk response
export const PositionRiskSchema = z.object({
  symbol: z.string(),
  positionAmt: z.string(),
  entryPrice: z.string(),
  unRealizedProfit: z.string(),
  leverage: z.string(),
  liquidationPrice: z.string(),
  marginType: z.string(),
});

// REST balance entry
export const BalanceEntrySchema = z.object({
  asset: z.string(),
  balance: z.string(),
  availableBalance: z.string(),
});

// REST commission rate
export const CommissionRateSchema = z.object({
  makerCommissionRate: z.string(),
  takerCommissionRate: z.string(),
});
