# Type Definitions (`packages/types`)

All shared domain types. Every other package depends on this one.

**Precision:** All numeric fields are `number` (float64). See [ADR-1](./architecture.md#adr-1-floating-point-precision).

```typescript
// === Market Data ===
// PRECISION: All numeric fields are float64. See ADR-1.

export type Timeframe = '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Candle {
  openTime: number; // unix ms
  closeTime: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  isClosed: boolean; // CRITICAL: false for the current forming candle
}

export interface Tick {
  symbol: string;
  price: number;
  quantity: number;
  timestamp: number; // unix ms
  isBuyerMaker: boolean;
}

export interface OrderBookSnapshot {
  symbol: string;
  timestamp: number;
  bids: [price: number, quantity: number][]; // sorted best (highest) first
  asks: [price: number, quantity: number][]; // sorted best (lowest) first
}

// Depth stream diff — used by subscribeOrderBookDiff().
// data-feed applies these to a local OrderBookSnapshot to maintain book state.
export interface OrderBookDiff {
  symbol: string;
  timestamp: number;
  bids: [price: number, quantity: number][]; // updated levels (qty=0 means remove)
  asks: [price: number, quantity: number][]; // updated levels (qty=0 means remove)
  firstUpdateId: number;
  lastUpdateId: number;
}

// === Orders & Positions ===

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
export type OrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';
export type PositionSide = 'LONG' | 'SHORT';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number; // required for LIMIT
  stopPrice?: number; // required for STOP_MARKET / TAKE_PROFIT_MARKET
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;
  clientOrderId?: string;
}

export interface OrderResult {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price: number; // requested price
  avgPrice: number; // actual fill price
  quantity: number; // requested qty
  filledQuantity: number; // actual filled qty
  commission: number; // fees paid
  commissionAsset: string;
  timestamp: number;
  latencyMs: number; // time from request to response
}

// Returned synchronously by order-executor's submit() — confirms the request is enqueued
export interface SubmissionReceipt {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  submittedAt: number; // unix ms — when enqueued, NOT when filled
}

export interface Position {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number;
  marginType: 'ISOLATED' | 'CROSS';
  timestamp: number;
}

// === Signals ===

export type SignalAction = 'ENTER_LONG' | 'ENTER_SHORT' | 'EXIT' | 'NO_ACTION';

export interface Signal {
  symbol: string;
  action: SignalAction;
  confidence: number; // 0-1
  price: number; // last close price at signal time — used by position-manager for sizing
  timestamp: number;
  sourceScanner: string; // which scanner emitted this
  metadata: Record<string, unknown>; // indicator values, reasons, etc
}

// === Risk ===
// These live in types (not risk-manager) because TradingEventMap in event-bus references them
// for the 'risk:breach' event payload. Both event-bus and risk-manager depend on types.

export type RiskRule =
  | 'MAX_POSITION_SIZE'
  | 'MAX_CONCURRENT'
  | 'MAX_DAILY_LOSS'
  | 'MAX_DRAWDOWN'
  | 'MAX_DAILY_TRADES'
  | 'COOLDOWN';

// REJECT = this entry is blocked, keep scanning for future entries
// KILL   = stop ALL trading activity (max daily loss, max drawdown breached)
export type RiskSeverity = 'REJECT' | 'KILL';

export type RiskCheckResult =
  | { allowed: true; quantity: number } // quantity computed by risk-manager (balance * pct * leverage / price)
  | { allowed: false; rule: RiskRule; reason: string; severity: RiskSeverity };

// === Account ===

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface FeeStructure {
  maker: number; // e.g. 0.0002 for 0.02%
  taker: number; // e.g. 0.0004 for 0.04%
  // BNB discount, VIP tiers, etc handled by implementation
}

// === Backtest ===

export interface TradeRecord {
  id: string;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryTime: number;
  exitTime: number;
  pnl: number; // net after fees
  fees: number;
  slippage: number; // difference between signal price and fill price
  holdTimeMs: number;
  exitReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'SIGNAL' | 'TIMEOUT' | 'FORCED';
  metadata: Record<string, unknown>;
}

export interface BacktestResult {
  trades: TradeRecord[];
  startTime: number;
  endTime: number;
  initialBalance: number;
  finalBalance: number;
  metrics: PerformanceMetrics;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number; // percentage
  maxDrawdownDuration: number; // ms
  avgWin: number;
  avgLoss: number;
  expectancy: number; // avg pnl per trade
  avgHoldTime: number; // ms
  totalFees: number;
  totalSlippage: number;
}

// === Config ===

export type ExchangeStream = 'kline' | 'aggTrade' | 'depth' | 'userData';

// === Exchange Config (discriminated union — see ADR-4) ===
// The type field is the discriminant. Each variant carries only the fields
// its adapter actually needs. The compiler enforces correctness — you can't
// accidentally pass backtest config to a live adapter.

interface ExchangeConfigBase {
  defaultLeverage?: number;
  recvWindow?: number;
}

export type ExchangeConfig =
  | (ExchangeConfigBase & {
      type: 'binance-live';
      apiKey: string;
      apiSecret: string;
    })
  | (ExchangeConfigBase & {
      type: 'binance-testnet';
      apiKey: string;
      apiSecret: string;
    })
  | (ExchangeConfigBase & {
      type: 'backtest-sim';
      feeStructure: FeeStructure;
      slippageModel: SlippageModel;
      initialBalance: number;
      // No apiKey/apiSecret — compile error if you try to access them
    });

export interface SlippageModel {
  type: 'fixed' | 'proportional' | 'orderbook-based';
  fixedBps?: number; // basis points for fixed model
  proportionalFactor?: number;
  maxSlippageBps?: number; // hard cap
}

// BacktestConfig is a RUN-LEVEL concern (time range, symbols, timeframes).
// Fee/slippage config lives on ExchangeConfig['backtest-sim'] because
// the exchange adapter is what simulates fills — the engine just replays data.
// timeframes is plural — multi-timeframe strategies (ADR-9) need candles
// at all timeframes loaded and replayed (e.g., 4h + 1m).
export interface BacktestConfig {
  startTime: number;
  endTime: number;
  symbols: string[];
  timeframes: Timeframe[]; // engine calls loader for every symbols × timeframes combination
}
```
