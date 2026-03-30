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
  safetyStopEnabled?: boolean;
  safetyStopMultiplier?: number; // default 2.0 — places safety stop at multiplier × SL distance
}

export type PositionState = 'IDLE' | 'PENDING_ENTRY' | 'OPEN' | 'PENDING_EXIT';

// === Interfaces: Exchange ===

export interface IExchange {
  getCandles(symbol: Symbol, timeframe: Timeframe, limit: number, startTime?: number, endTime?: number): Promise<Candle[]>;
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

// === Interfaces: Margin Guard ===

export interface IMarginGuard {
  readonly isBreached: boolean;
  dispose(): void;
}

export interface MarginGuardConfig {
  maxUnrealizedLossPct: number; // e.g., 10 — kill if total unrealized loss exceeds 10% of balance
  maxTotalExposurePct: number; // e.g., 50 — kill if total notional > 50% of balance
  evaluationEvent: 'tick' | 'candle:close'; // tick for live, candle:close for backtest
  balance: number; // account balance for pct calculations
}

// === Interfaces: Indicators ===

export interface IIndicator<TConfig = unknown, TOutput = number> {
  readonly name: string;
  readonly warmupPeriod: number;
  readonly config: TConfig;
  update(candle: Candle): TOutput | null;
  reset(): void;
}

// A zero-arg factory that creates a fresh, independent indicator instance.
// Config is pre-bound in the closure at the strategy factory level:
//   indicators: { ema: () => createEMA({ period: params.emaPeriod }) }
// Scanners call factory() with no args — they don't know or care about configs.
export type IndicatorFactory = () => IIndicator;

// === Interfaces: Scanner ===

export interface IScannerConfig {
  symbols: Symbol[];
  timeframe: Timeframe;
  indicators: Record<string, IndicatorFactory>;
}

export interface IScanner {
  readonly name: string;
  readonly config: IScannerConfig;
  dispose(): void;
}

export type ScannerFactory = (eventBus: IEventBus, config: IScannerConfig) => IScanner;

// Called on each candle:close for the scanner's timeframe.
// indicators: live values for this symbol (already updated with the current candle, only non-null)
// candle: the closed candle
// Returns a Signal to emit, or null for no signal this candle.
export type ScannerEvaluate = (
  indicators: Record<string, number>,
  candle: Candle,
  symbol: Symbol,
) => Omit<Signal, 'symbol' | 'sourceScanner' | 'timestamp'> | null;

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

// === Sweep / Evolution ===

/** Defines bounds for a single sweepable parameter. */
export interface ParamSpec {
  min: number;
  max: number;
  step?: number; // 1 for integers, 0.001 for percentages, undefined for continuous
}

/** Map of param names to their sweep bounds. */
export type ParamBounds = Record<string, ParamSpec>;

/**
 * Declares a scanner's identity and sweepable parameter space.
 * The evolutionary pipeline reads `params` to know what to vary.
 * `createFactory` builds a StrategyFactory that reads param values from the sweep grid.
 *
 * Scanner templates own signal params only (indicator periods, thresholds).
 * Position management params (SL/TP) are declared separately via PMParamBounds.
 * Risk config (max drawdown, daily loss) is fixed per tournament by the operator.
 */
export interface ScannerTemplate {
  name: string;
  description: string;
  params: ParamBounds;
  /** Additional timeframes this template needs beyond the primary entry timeframe. */
  requiredTimeframes?: Timeframe[];
  /** Optional constraint: returns false for invalid param combinations (e.g., fast >= slow). */
  isValid?: (params: Record<string, number>) => boolean;
  createFactory: (symbols: Symbol[], timeframe: Timeframe, riskConfig: RiskConfig, pmConfig: PositionManagerConfig) => StrategyFactory;
}

/**
 * Declares sweepable position management parameters.
 * Separate from scanner params — the sweep engine takes the cartesian product
 * of both grids, or they can be swept independently in different stages.
 */
export type PMParamBounds = ParamBounds;

/**
 * Default PM param bounds — covers common exit strategy params.
 * Individual scanners can narrow these if they have opinions about exits.
 */
export const DEFAULT_PM_PARAMS: PMParamBounds = {
  stopLossPct: { min: 1, max: 10, step: 0.5 },
  takeProfitPct: { min: 2, max: 20, step: 0.5 },
  maxHoldTimeHours: { min: 1, max: 48, step: 1 },
};

// === Tournament / Evolutionary Discovery ===

/** A candidate strategy: scanner template + concrete param values + PM config values. */
export interface TournamentCandidate {
  id: string;
  templateName: string;
  scannerParams: Record<string, number>;
  pmParams: Record<string, number>;
}

/** Result of a candidate's performance in one stage. */
export interface CandidateStageResult {
  candidateId: string;
  stageIndex: number;
  totalPnl: number;
  totalTrades: number;
  profitableWeeks: number;
  totalWeeks: number;
  avgProfitFactor: number;
  avgSharpe: number;
  maxDrawdown: number;
  survived: boolean;
}

/** Configuration for a single tournament stage. */
export interface TournamentStageConfig {
  /** Number of random weeks to test. */
  weeks: number;
  /** Number of random symbols to test. */
  symbols: number;
  /** Fraction to eliminate (0.25 = kill bottom 25%). */
  killRate: number;
}

/** Full tournament configuration. */
export interface TournamentConfig {
  /** Scanner templates to evolve. */
  templates: ScannerTemplate[];
  /** How many candidates to generate per template. */
  candidatesPerTemplate: number;
  /** PM param bounds to sweep (or fixed values). */
  pmParams: PMParamBounds;
  /** Number of PM param samples to combine with each scanner param set. */
  pmSamples: number;
  /** Risk config — fixed for all candidates in this tournament. */
  riskConfig: RiskConfig;
  /** Exchange config for backtesting. */
  exchangeConfig: ExchangeConfig;
  /** Timeframe to test on. */
  timeframe: Timeframe;
  /** Pool of symbols to select from. If empty/omitted, fetched dynamically. */
  symbolPool?: Symbol[];
  /** Available data range. */
  dataRange: { startTime: number; endTime: number };
  /** Progressive elimination stages. */
  stages: TournamentStageConfig[];
  /** RNG seed for deterministic tournaments. Same seed + same data = same results. */
  seed?: number;
}

/** Snapshot of tournament state — persisted for resume and audit. */
export interface TournamentState {
  config: TournamentConfig;
  currentStage: number;
  candidates: TournamentCandidate[];
  stageResults: CandidateStageResult[];
  /** Symbols selected for each stage (for reproducibility). */
  stageSymbols: Symbol[][];
  /** Week ranges selected for each stage (for reproducibility). */
  stageWeeks: Array<Array<{ startTime: number; endTime: number }>>;
  startedAt: number;
  completedStages: number;
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
  /** Extra candles loaded before startTime so indicators can warm up. Trades before startTime are discarded. */
  warmupMs?: number;
}

// === Strategy ===

export type SignalBuffer = Map<string, Signal[]>;

export type SignalMerge = (trigger: Signal, buffer: SignalBuffer) => Signal | null;

export interface StrategyConfig {
  name: string;
  symbols: Symbol[];
  scanners: IScanner[];
  signalMerge: SignalMerge;
  signalBufferWindowMs: number;
  positionManager: IPositionManager;
  riskManager: IRiskManager;
  marginGuard?: IMarginGuard;
}

export interface IStrategy {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Live-only — returns running performance metrics during live trading.
  // In backtest mode, results come from BacktestResult. Returns stub zeros in Phase 2.
  getStats(): PerformanceMetrics;
}

// Runner-provided environment — differs between backtest and live.
// The factory builds strategy-specific components (scanners, risk, position mgr)
// wired to these deps. It does NOT create bus, exchange, or executor.
export interface StrategyDeps {
  bus: IEventBus;
  exchange: IExchange;
  executor: IOrderExecutor;
}

export type StrategyFactory = (params: Record<string, number>, deps: StrategyDeps) => IStrategy;

export type SweepParamGrid = Record<string, number[]>;

// === Event Bus ===

export interface TradingEventMap {
  'candle:close': { symbol: Symbol; timeframe: Timeframe; candle: Candle };
  'candle:update': { symbol: Symbol; timeframe: Timeframe; candle: Candle };
  tick: { symbol: Symbol; tick: Tick };

  'scanner:signal': { signal: Signal };
  signal: { signal: Signal };

  'order:submitted': { receipt: SubmissionReceipt };
  'order:filled': { order: OrderResult };
  'order:rejected': { clientOrderId: ClientOrderId; reason: string };
  'order:canceled': { order: OrderResult };

  'position:opened': { position: Position };
  'position:updated': { position: Position };
  'position:closed': { position: Position; trade: TradeRecord };

  'risk:breach': { rule: RiskRule; message: string; severity: RiskSeverity };

  'exchange:connected': {
    stream: ExchangeStream;
    symbol: string;
    timestamp: number;
  };
  'exchange:disconnected': {
    stream: ExchangeStream;
    symbol: string;
    reason: 'ping_timeout' | 'server_close' | 'network_error' | 'manual' | 'maintenance';
    timestamp: number;
  };
  'exchange:reconnecting': {
    stream: ExchangeStream;
    symbol: string;
    attempt: number;
    timestamp: number;
  };
  'exchange:gap': {
    stream: ExchangeStream;
    symbol: string;
    fromTimestamp: number;
    toTimestamp: number;
    missedCandles?: number;
    timestamp: number;
  };

  error: { source: string; error: Error; context?: Record<string, unknown> };
}

export interface IEventBus {
  on<K extends keyof TradingEventMap>(event: K, handler: (data: TradingEventMap[K]) => void): void;
  off<K extends keyof TradingEventMap>(event: K, handler: (data: TradingEventMap[K]) => void): void;
  emit<K extends keyof TradingEventMap>(event: K, data: TradingEventMap[K]): void;
  once<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void;
  removeAllListeners(event?: keyof TradingEventMap): void;
  listenerCount(event: keyof TradingEventMap): number;
}
