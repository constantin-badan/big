// === Market Data ===

export type Timeframe = '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Candle {
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
  symbol: string;
  price: number;
  quantity: number;
  timestamp: number;
  isBuyerMaker: boolean;
}

export interface OrderBookSnapshot {
  symbol: string;
  timestamp: number;
  bids: [price: number, quantity: number][];
  asks: [price: number, quantity: number][];
}

export interface OrderBookDiff {
  symbol: string;
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

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
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
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  submittedAt: number;
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
}

export type PositionState = 'IDLE' | 'PENDING_ENTRY' | 'OPEN' | 'PENDING_EXIT';

// === Interfaces: Exchange ===

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

// === Interfaces: Order Executor ===

export interface IOrderExecutor {
  submit(request: OrderRequest): SubmissionReceipt;
  cancelAll(symbol: string): void;
  hasPending(symbol: string): boolean;
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
  getState(symbol: string): PositionState;
  hasOpenPosition(symbol: string): boolean;
  hasPendingOrder(symbol: string): boolean;
  getOpenPositions(): Position[];
  dispose(): void;
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
  symbols: string[];
  timeframes: Timeframe[]; // plural — engine calls loader for every symbol × timeframe combination
}
