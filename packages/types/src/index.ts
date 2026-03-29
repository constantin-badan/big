// === Branded Types ===
// Nominal types prevent accidental swaps between string fields (e.g., passing orderId where symbol is expected).
// Constructor functions (toSymbol, toOrderId, toClientOrderId) are the ONLY trust boundary.
// Internal code passes the branded value through without casting.

declare const __brand: unique symbol;
export type Symbol = string & { readonly [__brand]: 'Symbol' };
export type OrderId = string & { readonly [__brand]: 'OrderId' };
export type ClientOrderId = string & { readonly [__brand]: 'ClientOrderId' };

// Trust-boundary constructors — the ONLY place raw strings become branded types.
// Uses the overload trick to avoid `as` casts (banned by oxlint assertionStyle: "never").
export function toSymbol(s: string): Symbol;
export function toSymbol(s: string) { return s; }

export function toOrderId(s: string): OrderId;
export function toOrderId(s: string) { return s; }

export function toClientOrderId(s: string): ClientOrderId;
export function toClientOrderId(s: string) { return s; }

// === Market Data ===

export type Timeframe = '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Candle {
  symbol: Symbol;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  isClosed: boolean;
}

export interface Tick {
  symbol: Symbol;
  price: number;
  quantity: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

export interface OrderBookSnapshot {
  symbol: Symbol;
  timestamp: number;
  bids: [price: number, quantity: number][];
  asks: [price: number, quantity: number][];
}

export interface OrderBookDiff {
  symbol: Symbol;
  timestamp: number;
  bids: [price: number, quantity: number][];
  asks: [price: number, quantity: number][];
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

interface OrderRequestBase {
  symbol: Symbol;
  side: OrderSide;
  quantity: number;
  reduceOnly?: boolean;
  clientOrderId?: ClientOrderId;
}

export type OrderRequest =
  | (OrderRequestBase & { type: 'MARKET' })
  | (OrderRequestBase & { type: 'LIMIT'; price: number; timeInForce?: 'GTC' | 'IOC' | 'FOK' })
  | (OrderRequestBase & { type: 'STOP_MARKET'; stopPrice: number })
  | (OrderRequestBase & { type: 'TAKE_PROFIT_MARKET'; stopPrice: number });

export interface OrderResult {
  orderId: OrderId;
  clientOrderId: ClientOrderId;
  symbol: Symbol;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price: number;
  avgPrice: number;
  quantity: number;
  filledQuantity: number;
  commission: number;
  commissionAsset: string;
  timestamp: number;
  latencyMs: number;
}

export interface SubmissionReceipt {
  clientOrderId: ClientOrderId;
  symbol: Symbol;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  submittedAt: number;
}

export interface Position {
  symbol: Symbol;
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
  symbol: Symbol;
  action: SignalAction;
  confidence: number;
  price: number; // last close price at signal time — used by position-manager for entry sizing
  timestamp: number;
  sourceScanner: string;
  metadata: Record<string, unknown>;
}

// === Account ===

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface FeeStructure {
  maker: number;
  taker: number;
}

// === Risk ===

export type RiskRule =
  | 'MAX_POSITION_SIZE'
  | 'MAX_CONCURRENT'
  | 'MAX_DAILY_LOSS'
  | 'MAX_DRAWDOWN'
  | 'MAX_DAILY_TRADES'
  | 'COOLDOWN';

export type RiskSeverity = 'REJECT' | 'KILL';

export type RiskCheckResult =
  | { allowed: true; quantity: number } // quantity = balance * maxPositionSizePct * leverage / entryPrice
  | { allowed: false; rule: RiskRule; reason: string; severity: RiskSeverity };

// === Config: Risk ===

export interface RiskConfig {
  maxPositionSizePct: number;
  maxConcurrentPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxDailyTrades: number;
  cooldownAfterLossMs: number;
  leverage: number;
  initialBalance: number;
  expectedSlippageBps?: number;
}

// === Config: Position Manager ===

export interface PositionManagerConfig {
  defaultStopLossPct: number;
  defaultTakeProfitPct: number;
  trailingStopEnabled: boolean;
  trailingStopActivationPct: number;
  trailingStopDistancePct: number;
  maxHoldTimeMs: number;
  evaluationTimeframe?: Timeframe; // if set, only evaluate SL/TP on this timeframe's candle:close
  quantityStepSize?: number; // if set, round order quantity down to nearest step size
}

export type PositionState = 'IDLE' | 'PENDING_ENTRY' | 'OPEN' | 'PENDING_EXIT';

// === Interfaces: Exchange ===

export interface IExchange {
  getCandles(symbol: Symbol, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  getOrderBook(symbol: Symbol, depth?: number): Promise<OrderBookSnapshot>;

  subscribeCandles(
    symbol: Symbol,
    timeframe: Timeframe,
    callback: (candle: Candle) => void,
  ): () => void;
  subscribeTicks(symbol: Symbol, callback: (tick: Tick) => void): () => void;
  subscribeOrderBookDiff(symbol: Symbol, callback: (diff: OrderBookDiff) => void): () => void;

  placeOrder(request: OrderRequest): Promise<OrderResult>;
  cancelOrder(symbol: Symbol, orderId: OrderId): Promise<void>;
  getOpenOrders(symbol: Symbol): Promise<OrderResult[]>;

  getPosition(symbol: Symbol): Promise<Position | null>;
  getPositions(): Promise<Position[]>;
  setLeverage(symbol: Symbol, leverage: number): Promise<void>;

  getBalance(): Promise<AccountBalance[]>;
  getFees(symbol: Symbol): Promise<FeeStructure>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

// === Interfaces: Order Executor ===

export interface IOrderExecutor {
  submit(request: OrderRequest): SubmissionReceipt;
  cancelAll(symbol: Symbol): void;
  hasPending(symbol: Symbol): boolean;
  getPendingCount(): number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OrderExecutorConfig {
  maxRetries: number;
  retryDelayMs: number;
  rateLimitPerMinute: number;
}

export interface IFillSimulator {
  simulateFill(request: OrderRequest): OrderResult;
}

// === Interfaces: Risk Manager ===

export interface IRiskManager {
  checkEntry(signal: Signal, entryPrice: number): RiskCheckResult;
  isKillSwitchActive(): boolean;
  reset(): void;
  dispose(): void;
}

// === Interfaces: Position Manager ===

export interface IPositionManager {
  getState(symbol: Symbol): PositionState;
  hasOpenPosition(symbol: Symbol): boolean;
  hasPendingOrder(symbol: Symbol): boolean;
  getOpenPositions(): Position[];
  dispose(): void;
}

// === Backtest ===

export interface TradeRecord {
  id: string;
  symbol: Symbol;
  side: PositionSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  fees: number;
  slippage: number;
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
  maxDrawdown: number;
  maxDrawdownDuration: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  avgHoldTime: number;
  totalFees: number;
  totalSlippage: number;
}

// === Utilities ===

// KahanSum — compensated summation to eliminate floating-point drift
// in accumulated PnL, equity curves, total fees, and other running totals.
// Lives here (not in reporting) because multiple packages need it
// (risk-manager, reporting, parity-checker) and types has no dependencies.
export class KahanSum {
  private sum = 0;
  private compensation = 0;

  add(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`KahanSum: cannot add non-finite value (${value})`);
    }
    const y = value - this.compensation;
    const t = this.sum + y;
    this.compensation = t - this.sum - y;
    this.sum = t;
  }

  get value(): number {
    return this.sum;
  }

  reset(): void {
    this.sum = 0;
    this.compensation = 0;
  }
}

// === Config ===

export type ExchangeStream = 'kline' | 'aggTrade' | 'depth' | 'userData';

interface ExchangeConfigBase {
  defaultLeverage?: number;
  recvWindow?: number;
}

export type ExchangeConfig =
  | (ExchangeConfigBase & {
      type: 'binance-live';
      apiKey: string;
      privateKey: string;
    })
  | (ExchangeConfigBase & {
      type: 'binance-testnet';
      apiKey: string;
      privateKey: string;
    })
  | (ExchangeConfigBase & {
      type: 'backtest-sim';
      feeStructure: FeeStructure;
      slippageModel: SlippageModel;
      initialBalance: number;
    });

export type SlippageModel =
  | { type: 'fixed'; fixedBps: number; maxSlippageBps?: number }
  | { type: 'proportional'; proportionalFactor: number; maxSlippageBps?: number }
  | { type: 'orderbook-based'; maxSlippageBps?: number };

export interface BacktestConfig {
  startTime: number;
  endTime: number;
  symbols: Symbol[];
  timeframes: Timeframe[]; // plural — engine calls loader for every symbol × timeframe combination
}
