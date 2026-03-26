# Package Interfaces

All interface and type definitions for each package. Types referenced here are from `@trading-bot/types` (see [types.md](./types.md)).

---

## `exchange-client`

The most important interface. Abstracts all exchange interaction so that backtest, testnet, and live are swappable. See [ADR-5](./architecture.md#adr-5-raw-streams-in-iexchange-semantics-in-data-feed).

```typescript
import type { Candle, Tick, OrderRequest, OrderResult, Position,
  AccountBalance, FeeStructure, OrderBookSnapshot, OrderBookDiff, Timeframe } from '@trading-bot/types';

export interface IExchange {
  // Market data (REST)
  getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBookSnapshot>;

  // Raw stream subscriptions (return unsubscribe function)
  // These mirror what the exchange actually sends — NO filtering or aggregation.
  // data-feed is the ONLY consumer of these streams and owns the semantics:
  //   - Filtering isClosed on candles → emits candle:close vs candle:update events
  //   - Applying OrderBookDiff to a local snapshot → maintains book state
  //   - Backfilling gaps after reconnection via getCandles() REST
  // Connection lifecycle (reconnection, gap detection) is handled INTERNALLY by each adapter.
  // The adapter emits exchange:connected/disconnected/reconnecting/gap events on the event bus.
  // backtest-sim NEVER emits connection lifecycle events — the connection is always perfect.

  // Fires on EVERY kline update — forming (isClosed=false) AND closed (isClosed=true).
  // data-feed filters closes and routes to the appropriate event bus event.
  subscribeCandles(symbol: string, timeframe: Timeframe, callback: (candle: Candle) => void): () => void;

  // Fires on every aggTrade — already 1:1 with Binance's stream.
  subscribeTicks(symbol: string, callback: (tick: Tick) => void): () => void;

  // Fires on every depth update diff. data-feed maintains the local book by applying
  // diffs to an initial snapshot from getOrderBook().
  subscribeOrderBookDiff(symbol: string, callback: (diff: OrderBookDiff) => void): () => void;

  // Orders
  placeOrder(request: OrderRequest): Promise<OrderResult>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  getOpenOrders(symbol: string): Promise<OrderResult[]>;

  // Position
  getPosition(symbol: string): Promise<Position | null>;
  getPositions(): Promise<Position[]>;
  setLeverage(symbol: string, leverage: number): Promise<void>;

  // Account
  getBalance(): Promise<AccountBalance[]>;
  getFees(symbol: string): Promise<FeeStructure>;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

// Factory — single argument, the discriminated union does the selection.
// No separate ExchangeType needed — config.type IS the discriminant.
export function createExchange(config: ExchangeConfig): IExchange;
```

**Implementation note for the factory:** For now, the factory should `switch` on `config.type` and throw `'Not implemented: ${config.type}'` for all variants. We'll implement each adapter in later phases. The compiler will enforce exhaustiveness — adding a new union member without a case is a compile error.

---

## `event-bus`

Typed, synchronous event emitter. Backbone that prevents lookahead bias. See [ADR-2](./architecture.md#adr-2-synchronous-event-bus) and [ADR-3](./architecture.md#adr-3-connection-lifecycle-events).

**CRITICAL ARCHITECTURAL RULE — sync handlers only:** The event bus is synchronous and all handlers MUST be synchronous. Handlers must never `await` anything. If a handler needs to trigger async work (e.g., placing an order on Binance), it must call a synchronous `submit()` method that enqueues the work — the async I/O runs on its own loop outside the event pipeline. The result comes back as a separate event (e.g., `order:filled`). This keeps the event pipeline deterministic in both backtest and live modes, and avoids backing up the pipeline when Binance is slow. See `IOrderExecutor` below for the concrete pattern.

```typescript
// Define the full event map — every event in the system is typed here
// ExchangeStream type is imported from @trading-bot/types

export interface TradingEventMap {
  // Market data
  'candle:close': { symbol: string; timeframe: Timeframe; candle: Candle };
  'candle:update': { symbol: string; timeframe: Timeframe; candle: Candle };  // forming candle
  'tick': { symbol: string; tick: Tick };

  // Signals — two-tier routing (see ADR-9):
  //   scanner:signal = raw output from a single scanner (may need merging)
  //   signal         = actionable signal after strategy's merge logic
  // Position-manager subscribes to 'signal' only. Strategy subscribes to 'scanner:signal'.
  'scanner:signal': { signal: Signal };   // emitted by scanners
  'signal': { signal: Signal };           // emitted by strategy after merge

  // Orders — note: order:submitted is SYNC (enqueued), order:filled is ASYNC (result arrived)
  'order:submitted': { receipt: SubmissionReceipt };   // fired immediately by submit()
  'order:filled': { order: OrderResult };              // fired when the exchange confirms fill
  'order:rejected': { clientOrderId: string; reason: string };
  'order:canceled': { order: OrderResult };

  // Positions
  'position:opened': { position: Position };
  'position:updated': { position: Position };
  'position:closed': { position: Position; pnl: number };

  // Risk (RiskRule and RiskSeverity imported from @trading-bot/types)
  'risk:breach': { rule: RiskRule; message: string; severity: RiskSeverity };

  // Exchange connection lifecycle (live trading only — backtest-sim never emits these)
  'exchange:connected': {
    stream: ExchangeStream;
    symbol: string;
    timestamp: number;
  };
  'exchange:disconnected': {
    stream: ExchangeStream;
    symbol: string;
    reason: 'ping_timeout' | 'server_close' | 'network_error' | 'manual';
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
    fromTimestamp: number;   // last known good data point
    toTimestamp: number;     // first data point after reconnect
    missedCandles?: number;  // estimated, for kline streams
    timestamp: number;
  };

  // System
  'error': { source: string; error: Error; context?: Record<string, unknown> };
}

export interface IEventBus {
  on<K extends keyof TradingEventMap>(event: K, handler: (data: TradingEventMap[K]) => void): void;
  off<K extends keyof TradingEventMap>(event: K, handler: (data: TradingEventMap[K]) => void): void;
  emit<K extends keyof TradingEventMap>(event: K, data: TradingEventMap[K]): void;
  once<K extends keyof TradingEventMap>(event: K, handler: (data: TradingEventMap[K]) => void): void;
  removeAllListeners(event?: keyof TradingEventMap): void;

  // Debug / monitoring
  listenerCount(event: keyof TradingEventMap): number;
}
```

**Implement this fully** with an `EventBus` class. It should be:
- Synchronous (handlers run inline, not deferred — critical for deterministic backtesting)
- Type-safe (wrong event/payload combos are compile errors)
- Handler signatures are `(data: T) => void` — NOT `(data: T) => Promise<void>`. The type system enforces this: if a handler returns a Promise, TypeScript should flag it as a type error.
- Include error boundary per handler (one handler throwing shouldn't kill other handlers)
- Log handler errors to console.error with the event name and handler name

Write tests for: basic on/off/emit, once, type safety (compile-time — just ensure the types work), error isolation between handlers, removeAllListeners.

---

## `indicators`

See [ADR-6](./architecture.md#adr-6-indicator-and-scanner-factory-pattern).

```typescript
export interface IIndicator<TConfig = unknown, TOutput = number> {
  readonly name: string;
  readonly warmupPeriod: number;   // how many candles needed before output is valid
  readonly config: TConfig;        // exposed for logging, reporting, sweep output
  update(candle: Candle): TOutput | null;  // null during warmup
  reset(): void;
  // No clone() — use IndicatorFactory to create fresh instances instead.
  // This avoids deep-copy bugs with nested indicator state (e.g., EMA feeding EMA).
}

// A factory is just a function that creates a fresh, stateless indicator instance.
// Scanners hold factories (not instances) so each backtest run / parallel strategy
// gets independent state by calling the factory. No shared mutable state is possible.
export type IndicatorFactory<TConfig = unknown, TOutput = number> =
  (config: TConfig) => IIndicator<TConfig, TOutput>;
```

---

## `data-feed`

See [ADR-5](./architecture.md#adr-5-raw-streams-in-iexchange-semantics-in-data-feed).

```typescript
export interface IDataFeed {
  start(symbols: string[], timeframes: Timeframe[]): Promise<void>;
  stop(): Promise<void>;

  // data-feed is the SEMANTIC LAYER between raw exchange streams and the event bus.
  // It is the ONLY source of candle/tick events in the system. Responsibilities:
  //   1. Subscribes to IExchange.subscribeCandles() — filters by isClosed:
  //      - isClosed === true  → emits 'candle:close' on event bus
  //      - isClosed === false → emits 'candle:update' on event bus
  //   2. Subscribes to IExchange.subscribeTicks() → emits 'tick' on event bus
  //   3. Subscribes to IExchange.subscribeOrderBookDiff() — maintains a local
  //      OrderBookSnapshot by applying diffs to an initial getOrderBook() snapshot.
  //      Exposes the current book via getOrderBook() for position-manager/risk-manager.
  //   4. Listens for 'exchange:gap' events — backfills missing candles via
  //      the internal async queue (see below).
  //
  // In backtest mode, the backtest-sim adapter replays historical candles with
  // isClosed=true on every call, so data-feed works identically — no special casing.
  //
  // === Gap backfill (async queue pattern, same as order-executor — see ADR-2) ===
  //
  // When an 'exchange:gap' event arrives, the gap handler is SYNC per ADR-2.
  // It does NOT await getCandles(). Instead it follows the submit() pattern:
  //
  //   1. Sets a backfilling flag for that symbol/timeframe pair
  //   2. Enqueues a backfill job (symbol, timeframe, fromTimestamp, toTimestamp)
  //   3. While backfilling=true, incoming stream candles for that pair are BUFFERED
  //   4. The internal async queue calls getCandles() REST, emits each
  //      backfilled candle as 'candle:close' on the bus
  //   5. Deduplicates: if a backfilled candle and a buffered live candle share
  //      the same openTime, the live one is dropped (REST is canonical — guaranteed
  //      complete and closed)
  //   6. Clears the backfilling flag, flushes remaining buffered candles in order
  //
  // The queue is PER-SYMBOL-PER-TIMEFRAME — ETHUSDT candles are not blocked
  // behind BTCUSDT's backfill. Each pair has its own flag and buffer.

  // Current order book state (maintained from diffs)
  getOrderBook(symbol: string): OrderBookSnapshot | null;
}
```

---

## `position-manager`

See [ADR-2](./architecture.md#adr-2-synchronous-event-bus) for sync-only rationale, [ADR-8](./architecture.md#adr-8-constructor-injected-reactive-components) for the reactive pattern.

```typescript
export interface PositionManagerConfig {
  defaultStopLossPct: number;
  defaultTakeProfitPct: number;
  trailingStopEnabled: boolean;
  trailingStopActivationPct: number;  // profit % to activate trailing
  trailingStopDistancePct: number;    // distance from peak
  maxHoldTimeMs: number;              // timeout exit
}

// Position lifecycle: IDLE → PENDING_ENTRY → OPEN → PENDING_EXIT → IDLE
// The PENDING states exist because submit() is sync but fills are async.
// In backtest-sim, PENDING states resolve instantly (same tick). In live, there's real delay.
// The position-manager MUST track these states to prevent duplicate entries
// (e.g., scanner fires again while the first entry order is in-flight).
export type PositionState = 'IDLE' | 'PENDING_ENTRY' | 'OPEN' | 'PENDING_EXIT';

export interface IPositionManager {
  // REACTIVE — constructor receives (eventBus, orderExecutor, riskManager, config)
  // and subscribes to events immediately (see ADR-8):
  //   - 'tick'            → evaluates SL/TP/trailing on open positions
  //   - 'signal'          → calls riskManager.checkEntry(), then orderExecutor.submit()
  //   - 'order:filled'    → transitions PENDING_ENTRY → OPEN or PENDING_EXIT → IDLE
  //   - 'order:rejected'  → transitions PENDING_ENTRY → IDLE or PENDING_EXIT → OPEN
  //
  // No onTick(), onSignal(), onOrderFilled() methods — the bus delivers events directly.

  // Query methods only — all sync
  getState(symbol: string): PositionState;
  hasOpenPosition(symbol: string): boolean;
  hasPendingOrder(symbol: string): boolean;
  getOpenPositions(): Position[];

  // Cleanup — unsubscribes from the event bus
  dispose(): void;
}
```

---

## `risk-manager`

See [ADR-7](./architecture.md#adr-7-reactive-risk-manager-with-structured-results).

```typescript
// RiskRule, RiskSeverity, and RiskCheckResult are imported from @trading-bot/types
// (they live there because TradingEventMap in event-bus also references RiskRule).

export interface RiskConfig {
  maxPositionSizePct: number;     // max % of balance per position
  maxConcurrentPositions: number;
  maxDailyLossPct: number;        // kill switch (severity: KILL)
  maxDrawdownPct: number;         // kill switch (severity: KILL)
  maxDailyTrades: number;
  cooldownAfterLossMs: number;    // wait after a losing trade
}

export interface IRiskManager {
  // The risk manager is REACTIVE — it subscribes to the event bus and builds
  // its own internal state from events:
  //   - 'order:filled'     → tracks trade count, last trade timestamp
  //   - 'position:opened'  → tracks concurrent position count
  //   - 'position:closed'  → tracks PnL, drawdown, daily loss
  //   - balance updates    → tracks current balance
  //
  // checkEntry only needs the signal — the risk manager already knows
  // the balance, open positions, trade count, and last loss timestamp.
  // No caller-provided context needed (see ADR-7).
  checkEntry(signal: Signal): RiskCheckResult;

  // Quick probe — is the kill switch active? (max daily loss or max drawdown breached)
  // Other components can check this without submitting a fake signal.
  isKillSwitchActive(): boolean;

  // Reset between backtest runs
  reset(): void;

  // Cleanup — unsubscribes from the event bus
  dispose(): void;
}
```

---

## `order-executor`

See [ADR-2](./architecture.md#adr-2-synchronous-event-bus) for the sync `submit()` pattern.

```typescript
export interface OrderExecutorConfig {
  maxRetries: number;
  retryDelayMs: number;
  rateLimitPerMinute: number;    // Binance limits
}

export interface IOrderExecutor {
  // SYNC — enqueues the order and returns immediately with a receipt.
  // The actual exchange call happens asynchronously on an internal queue.
  // Results arrive as 'order:filled' / 'order:rejected' events on the event bus.
  // In backtest-sim mode, submit() processes the order IMMEDIATELY and synchronously
  // (simulated fill, instant event emission) — so the event bus sees
  // submit → order:filled in the same tick. In live mode, there's a real delay.
  submit(request: OrderRequest): SubmissionReceipt;

  // Cancel is also fire-and-forget; result arrives as 'order:canceled' event
  cancelAll(symbol: string): void;

  // Check if there are orders still in-flight (submitted but not yet filled/rejected)
  hasPending(symbol: string): boolean;
  getPendingCount(): number;

  // Lifecycle — starts/stops the internal async processing queue (no-op in backtest-sim)
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

---

## `scanner`

See [ADR-6](./architecture.md#adr-6-indicator-and-scanner-factory-pattern), [ADR-8](./architecture.md#adr-8-constructor-injected-reactive-components), [ADR-9](./architecture.md#adr-9-multi-timeframe-composition-via-signal-routing).

```typescript
export interface IScannerConfig {
  symbols: string[];
  timeframe: Timeframe;             // each scanner operates on ONE timeframe
  // Factories, NOT instances. Each backtest run / parallel strategy calls these
  // to create independent indicator instances. No shared mutable state.
  indicators: Record<string, IndicatorFactory>;
}

export interface IScanner {
  // REACTIVE — constructor receives (eventBus, config) and subscribes immediately (see ADR-8):
  //   - 'candle:close' (filtered by config.timeframe) → evaluates indicators,
  //     emits 'scanner:signal' events on the bus (NOT 'signal' — see ADR-9).
  //
  // Strategy subscribes to 'scanner:signal', applies merge logic, and emits
  // 'signal' (actionable) which position-manager listens to.
  //
  // No onCandleClose() method or return value — signals flow through events.
  // Must NOT have access to future candles.
  // Must be deterministic given the same sequence of candle:close events.

  readonly name: string;
  readonly config: IScannerConfig;

  // Cleanup — unsubscribes from the event bus
  dispose(): void;
}

// Scanners are created via factories. The factory receives the event bus
// so the scanner can self-subscribe in its constructor.
// Each backtest run / parallel strategy gets a fresh instance with fresh indicators.
export type ScannerFactory = (eventBus: IEventBus, config: IScannerConfig) => IScanner;
```

---

## `strategy`

See [ADR-8](./architecture.md#adr-8-constructor-injected-reactive-components), [ADR-9](./architecture.md#adr-9-multi-timeframe-composition-via-signal-routing).

```typescript
// Signal buffer maintained by strategy, keyed by sourceScanner name.
// Holds recent signals within a configurable time window.
export type SignalBuffer = Map<string, Signal[]>;

// Called every time any scanner emits 'scanner:signal'.
// Receives the triggering signal and the full buffer of recent signals from all scanners.
// Returns an actionable signal (emitted as 'signal' on the bus) or null (not yet).
// For single-scanner strategies, this is a simple pass-through: (trigger) => trigger
export type SignalMerge = (
  trigger: Signal,           // the scanner:signal that just arrived
  buffer: SignalBuffer,      // recent signals from all scanners, time-windowed
) => Signal | null;          // null = no actionable signal yet

export interface StrategyConfig {
  name: string;
  symbols: string[];
  // No single timeframe — each scanner carries its own (see ADR-9).
  // These are INSTANCES for a single run — created fresh via factories by the engine.
  // All components are already wired to the event bus via their constructors (ADR-8).
  scanners: IScanner[];              // one or more, each on its own timeframe
  signalMerge: SignalMerge;          // composites — pass-through for single scanner
  signalBufferWindowMs: number;      // how long to keep signals (e.g., 4h for multi-TF)
  positionManager: IPositionManager;
  riskManager: IRiskManager;
}

export interface IStrategy {
  // REACTIVE — subscribes to 'scanner:signal' on the bus, applies signalMerge,
  // emits 'signal' (actionable) when merge returns non-null.
  // Position-manager only hears 'signal', never 'scanner:signal'.
  // Strategy also manages lifecycle: start trading, stop trading, report stats.
  // On stop(), calls dispose() on all components.
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStats(): PerformanceMetrics;
}

// === Strategy factory for sweep/arena ===
// A function that takes a numeric parameter vector and returns a fully wired IStrategy.
// The user writes this once per strategy — it captures all wiring knowledge:
// which indicators, which scanner, which risk config, which merge function.
//
// CRITICAL: Each invocation MUST create its own EventBus. If two strategy instances
// share a bus, one run's events contaminate the other. The bus is created INSIDE
// the factory body, never closed over from outside.
//
// Params are Record<string, number> because sweep parameters are almost always
// numeric (periods, percentages, thresholds). Non-numeric config (symbols, timeframe,
// merge function) is fixed in the factory closure — it doesn't vary across a sweep.
export type StrategyFactory = (params: Record<string, number>) => IStrategy;

// Param grid for sweep-engine: each key maps to an array of values to try.
// Sweep-engine computes the cartesian product to get all param combinations.
export type SweepParamGrid = Record<string, number[]>;
```

---

## `backtest-engine`

```typescript
export interface IBacktestEngine {
  run(config: BacktestConfig, strategy: IStrategy): Promise<BacktestResult>;
}
```

---

## `sweep-engine`

```typescript
export interface SweepConfig {
  backtestConfig: BacktestConfig;     // time range, symbols
  exchangeConfig: ExchangeConfig;     // must be 'backtest-sim' variant
}

export interface SweepResult {
  params: Record<string, number>;
  result: BacktestResult;
}

export interface ISweepEngine {
  // Takes a strategy factory + param grid, runs the cartesian product of params
  // through the backtest engine. Each run gets a fresh strategy from the factory.
  // Returns results sorted by a metric (e.g., profitFactor, sharpeRatio).
  run(
    factory: StrategyFactory,
    grid: SweepParamGrid,
    config: SweepConfig,
  ): Promise<SweepResult[]>;
}
```

---

## `reporting`

`KahanSum` is fully implemented in Phase 1. Rest is stub. See [ADR-1](./architecture.md#adr-1-floating-point-precision).

```typescript
// KahanSum — compensated summation to eliminate floating-point drift
// in accumulated PnL, equity curves, total fees, and parity-checker diffs.
// Use this instead of naive += for any running total across trades.
export class KahanSum {
  private sum = 0;
  private compensation = 0;

  add(value: number): void {
    const y = value - this.compensation;
    const t = this.sum + y;
    this.compensation = (t - this.sum) - y;
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
```

**Tests for `KahanSum`:**
- Sum 10,000 additions of `0.1` — naive `+=` gives `999.9999...98`, KahanSum gives exactly `1000`
- Sum alternating `+large` / `-large` values with a small residual — verify the residual is preserved
- Verify `reset()` zeroes both sum and compensation

---

## `test-utils`

Shared test infrastructure. **devDependency only** — never imported in production `src/` code, only in `src/__tests__/` files. Excluded from module boundary enforcement (see [tooling.md](./tooling.md)).

Fully implemented in Phase 1. All other package tests should use these instead of building their own mocks.

```typescript
// === EventCapture — records all events emitted on a bus ===

export class EventCapture {
  // Attaches to any bus — can wrap one you created or one a component constructed
  constructor(bus: IEventBus);

  // Get all payloads emitted for a specific event type
  get<K extends keyof TradingEventMap>(event: K): TradingEventMap[K][];

  // Assert helpers
  count<K extends keyof TradingEventMap>(event: K): number;
  last<K extends keyof TradingEventMap>(event: K): TradingEventMap[K] | undefined;

  // Reset recorded events
  clear(): void;

  // Stop capturing (unsubscribes from bus)
  dispose(): void;
}

// Convenience: creates a fresh EventBus + EventCapture pre-wired
export function createTestBus(): { bus: EventBus; capture: EventCapture };

// === Mock IExchange ===
// No-op implementation with configurable return values.
// All methods return sensible defaults (empty arrays, null positions, etc).
// Override specific methods via config or direct assignment.

export interface MockExchangeConfig {
  candles?: Candle[];               // getCandles() returns these
  orderBook?: OrderBookSnapshot;    // getOrderBook() returns this
  fees?: FeeStructure;              // getFees() returns this
  balance?: AccountBalance[];       // getBalance() returns these
}

export function createMockExchange(config?: MockExchangeConfig): IExchange;

// === Mock IOrderExecutor ===
// Operates in two modes:
//   syncFill: true  — submit() emits order:filled immediately on the bus (backtest behavior)
//   syncFill: false — submit() returns receipt only, no fill event (live behavior)
// Tracks all submitted orders for assertions.

export interface MockExecutorConfig {
  syncFill?: boolean;               // default: true (backtest mode)
  fillPrice?: number;               // default: order request price
  commission?: number;              // default: 0
  rejectAll?: boolean;              // submit() emits order:rejected instead
  rejectReason?: string;
}

export function createMockExecutor(
  bus: IEventBus,
  config?: MockExecutorConfig
): IOrderExecutor;

// === Fixtures — deterministic test data ===

export const fixtures: {
  // Candles: 100 1m BTCUSDT candles starting at a fixed timestamp
  candles: Candle[];

  // A single closed candle with known values
  candle: Candle;

  // Tick
  tick: Tick;

  // Signals
  longSignal: Signal;
  shortSignal: Signal;
  exitSignal: Signal;

  // Order results
  filledBuy: OrderResult;
  filledSell: OrderResult;
  rejectedOrder: OrderResult;

  // Position
  openLong: Position;

  // Config
  defaultRiskConfig: RiskConfig;
  defaultPositionManagerConfig: PositionManagerConfig;
};
```

**Tests for `test-utils` itself:**
- `EventCapture` records events emitted on the bus, `get()` returns correct payloads, `clear()` resets, `dispose()` stops capturing
- `createMockExchange` returns an IExchange where all methods resolve without error
- `createMockExecutor` with `syncFill: true` emits `order:filled` synchronously on `submit()`
- `createMockExecutor` with `syncFill: false` does not emit any events on `submit()`
- `createMockExecutor` with `rejectAll: true` emits `order:rejected` on `submit()`
- All fixtures have deterministic values (no `Date.now()`, no `Math.random()`)