# Phase 3 — Live Trading & Evolution

Phase 2 delivers a working backtest + sweep pipeline. Phase 3 connects it to the real world.

**Target exchange:** Binance USDⓈ-M Futures only. Not Spot, not COIN-M. The type system is futures-native (leverage, liquidationPrice, marginType, STOP_MARKET, positionSide). Different endpoints, different settlement — document this clearly so the implementer doesn't accidentally build against the wrong API.

---

## Sub-phasing: 3a-minimal → 3a-hardened

Phase 3a is split into two deliverables. The minimal version validates end-to-end data flow on testnet before investing in production hardening.

### 3a-minimal — First deliverable: strategy running on testnet

**Goal:** A strategy that ran profitably in backtest now runs on Binance testnet using the same `StrategyFactory`. Proof that the `IExchange` abstraction works — same factory, different environment, real market data.

**Implementation order:**

1. **Exchange adapter** (`binance-testnet` variant)
   - `connect()`: open market data WS + trading API WS
   - `session.logon()` for Ed25519 auth
   - `subscribeCandles/Ticks`: combined stream, message routing
   - `placeOrder()`: `order.place` or `algoOrder.place` based on type
   - `getCandles/getBalance/getPositions`: REST for initial state
   - No reconnection — if WS drops, throw and let runner crash
   - `newOrderRespType: RESULT` for MARKET orders (fill in ack), `ACK` for LIMIT
   - Adapter deduplicates fills: don't emit `order:filled` twice for same `orderId` (ack + user data stream)

2. **LiveDataFeed**
   - `start()`: subscribe to exchange, set up semantic routing
   - `handleCandle`: filter `isClosed`, emit `candle:close` / `candle:update`
   - `handleTick`: emit `tick`
   - No order book maintenance, no gap backfill
   - `getOrderBook()` returns `null`

3. **LiveExecutor**
   - `submit()`: enqueue, emit `order:submitted`, return receipt, add to pending set
   - Queue processor: token bucket (fixed rate, no response sync)
   - Subscribe to `order:filled` / `order:rejected` on bus to update pending set
   - No retry logic — if `placeOrder()` rejects, emit `order:rejected`
   - Priority queue: cancels jump ahead of new orders

4. **LiveRunner**
   - `start()`: create bus, exchange, executor, data-feed, call factory
   - `stop()`: stop data-feed → stop strategy → drain executor → disconnect
   - `shutdownBehavior: 'leave-open'` only (no `close-all`)
   - No orphan position detection on startup
   - No health checks
   - Structured JSON logging of all key events
   - 30s heartbeat with `lastCandleAge` staleness detection

**Testnet caveat:** Binance testnet has thin order books, unrealistic fills, occasional API differences. Use it only to validate integration plumbing. Real parameter tuning stays in backtest.

### 3a-hardened — Incremental improvements to working code

Each item is a self-contained change, shipped and tested individually on testnet:

- **Reconnection**: Exponential backoff with jitter: `min(1000 * 2^attempt + random(0-500), 30000)`. Reset attempt counter on successful reconnect (not on first retry). Retry forever.
- **KILL after N failures**: Emit `risk:breach` with severity `KILL` after 10 consecutive reconnect failures (~5min of downtime). Kill switch latches until daily reset or manual intervention.
- **Lifecycle events**: `exchange:connected`, `exchange:disconnected`, `exchange:reconnecting`, `exchange:gap` emitted by adapter. Per-stream-key `lastMessageTimestamp` for gap detection.
- **24h hot-swap rotation**: Open second connection, verify messages flowing, swap dispatch map, close old connection. Zero-gap rotation. Trading API connection: simpler — just re-authenticate with `session.logon`.
- **Gap backfill in LiveDataFeed**: `backfilling` flag per symbol/timeframe, async queue, dedup by `openTime`. Per-symbol-per-timeframe — ETHUSDT not blocked behind BTCUSDT's backfill.
- **Response-based rate sync**: Token bucket adjusted against Binance's reported `count` in WS API responses.
- **LiveExecutor retry**: Retry transport failures with exponential backoff. Never retry business rejections (order rejected by exchange is a definitive answer).
- **Configurable shutdown**: `close-all` | `leave-open`. Sequence: stop data-feed → stop strategy → cancel all pending (close-all) or drain queue (leave-open) → handle positions → disconnect. Cancel/drain before position handling prevents queued entries from executing after "closing all."
- **Orphan position detection**: `getPositions()` on startup, refuse if orphaned positions exist (override with `--force`).
- **Health check loop**: Configurable interval, connection status monitoring.
- **Safety stop**: Exchange-side `STOP_MARKET` at 2× SL distance as crash safety net. Client-side SL/TP for responsiveness, exchange-side for crash survival. Place on entry, cancel on normal exit.
- **Order book recovery**: Simple re-snapshot on reconnect (full buffer-and-sequence-validate recovery deferred to 3c).

---

## 3a. Live data infrastructure — Architecture decisions

### WebSocket topology: Two connections total

1. **Market data** (combined stream): `wss://fstream.binance.com/stream?streams=...`
   - All klines, aggTrades, depth diffs multiplexed on one connection
   - Messages dispatched by parsing the `stream` field against an internal dispatch map
   - One disconnect = clean "all data stopped" state (no partial outages)
   - Per-stream-key `lastMessageTimestamp` tracking for gap detection

2. **Trading + user data** (WebSocket API): `wss://ws-fapi.binance.com/ws-fapi/v1`
   - `session.logon` for Ed25519 authentication
   - `order.place` / `order.modify` / `order.cancel` for MARKET and LIMIT orders
   - `algoOrder.place` / `algoOrder.cancel` for conditional orders (STOP_MARKET, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET) — Binance Algo Service (since December 2025)
   - User data events: `ORDER_TRADE_UPDATE` (regular fills) + `ALGO_UPDATE` (conditional order triggers/rejections)
   - No separate listen key connection needed — `session.logon` handles it

### Connection ownership: Exchange adapter owns both (ADR-5)

The exchange adapter owns both WebSocket connections and manages reconnection. Data-feed never touches a socket — it calls `exchange.subscribeCandles()` etc. and receives typed callbacks. The abstraction is what makes backtest and live interchangeable.

Internal adapter wiring:
- `connect()` opens both sockets
- `subscribeCandles(symbol, tf, cb)` adds `${symbol.toLowerCase()}@kline_${tf}` to combined stream and registers callback in dispatch map
- `subscribeTicks(symbol, cb)` adds `${symbol.toLowerCase()}@aggTrade`
- `subscribeOrderBookDiff(symbol, cb)` adds `${symbol.toLowerCase()}@depth@100ms`
- Incoming messages parsed, `stream` field matched against dispatch map, typed callback invoked
- `disconnect()` closes both sockets

### Authentication: Ed25519

- `apiKey` (public key registered on Binance) + `privateKey` (Ed25519 private key, PEM or base64)
- No `apiSecret` — renamed to `privateKey` in config types for semantic clarity
- `signPayload(params, privateKey): string` — shared pure function for both REST and WS API
- Bun native `crypto.sign('Ed25519', data, privateKey)`, base64 encode result
- Private key from environment variables, no file path indirection

### Algo service routing (hidden inside adapter)

The adapter routes orders internally based on `OrderRequest.type`:
- `MARKET` | `LIMIT` → `order.place`
- `STOP_MARKET` | `TAKE_PROFIT_MARKET` → `algoOrder.place`

User data stream handler normalizes both event types:
- `ORDER_TRADE_UPDATE` → `OrderResult` → `order:filled` / `order:rejected`
- `ALGO_UPDATE` → `OrderResult` → `order:filled` / `order:rejected`

No interface changes — `placeOrder(request)` abstracts everything.

### placeOrder response handling

`placeOrder(): Promise<OrderResult>` resolves with the exchange's acknowledgment, not the fill.
- For MARKET orders: set `newOrderRespType: RESULT` — Binance returns fill data in the ack. The adapter can detect `status: FILLED` and emit `order:filled` immediately.
- For LIMIT/conditional orders: set `newOrderRespType: ACK` — fill comes later via user data stream.
- User data stream also sends fill events for MARKET orders → adapter must deduplicate by `orderId` to avoid double `order:filled` emission.

### Fill emission flow

Adapter emits `order:filled` on the bus (from user data stream or MARKET ack). Executor listens to update pending set:

```
submit() → enqueue → pending.add(clientOrderId)
queue processor → send via WS → (async, fire-and-forget)
exchange adapter receives fill → emits order:filled on bus
executor hears order:filled → pending.delete(clientOrderId)
position-manager hears order:filled → state transition
```

Unknown fills (orders placed via Binance UI) pass through cleanly — `pending.delete()` is a no-op, position-manager ignores them.

### Rate limiting: Token bucket with priority queue

- **Token bucket**: `tokens = min(maxTokens, tokens + elapsed * refillRate)`, `maxTokens = 60` (5% of 1200), `refillRate = 20/sec`
- **Priority queue**: Cancels at the front, new orders at the back. All order operations (place, cancel, algo) share Binance's single 1200/min counter.
- **Response sync** (3a-hardened): Adjust local token count against Binance's reported `count` in WS API responses.

### Entry/exit order types

- **Entries**: MARKET default. `entryOrderType` field in `PositionManagerConfig` for future LIMIT support. MARKET-only in Phase 3a-minimal.
- **Exits**: Client-side SL/TP evaluation from tick data → MARKET exit order. Not `STOP_MARKET` on the exchange (consistent between backtest and live). Exchange-side safety stop at 2× SL distance added in 3a-hardened.

### Testing strategy

**Layer 1 — Unit tests (90% of coverage, no network):**

Pure functions:
- `signPayload(params, privateKey): string`
- `parseCombinedStreamMessage(raw): { stream, data }`
- `parseKlineMessage(data): Candle`
- `parseAggTradeMessage(data): Tick`
- `parseDepthMessage(data): OrderBookDiff`
- `parseOrderTradeUpdate(data): OrderResult`
- `parseAlgoUpdate(data): OrderResult`
- `buildOrderParams(request: OrderRequest): Record<string, unknown>`
- `routeOrderType(type: OrderType): 'order.place' | 'algoOrder.place'`

Stateful but testable (in-memory):
- `StreamDispatcher`: register callbacks, feed parsed messages, assert right callback fires
- `TokenBucket`: add tokens, consume, verify throttling
- `PendingOrderTracker`: add on submit, remove on fill, query `hasPending`

**Layer 2 — Testnet smoke tests (tagged `@integration`, run manually):**
- Place a real order on testnet, verify round-trip (ack + fill event)
- Subscribe to BTCUSDT kline 1m, assert 2 consecutive candle closes with sequential `openTime` values (takes ~2min)

**Layer 3 — Recorded message replay:**
- Capture real combined stream output to JSON fixtures from a testnet session
- Feed recorded messages through parse functions, assert output
- Real Binance formats without maintaining a mock server

---

## 3b. Live runner

### Config

```typescript
interface LiveRunnerConfig {
  factory: StrategyFactory;
  params: Record<string, number>;
  exchangeConfig: ExchangeConfig;     // binance-live or binance-testnet
  symbols: string[];
  timeframes: Timeframe[];
  shutdownBehavior: 'close-all' | 'leave-open';  // default: 'leave-open'
  healthCheckIntervalMs: number;      // default: 30_000
}
```

`riskConfig` is NOT in runner config — captured in strategy factory closure (ADR-10).

### Interface

```typescript
interface ILiveRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly status: 'idle' | 'running' | 'stopping' | 'stopped';
  readonly strategy: IStrategy;       // access getStats() through this
  readonly uptime: number;            // ms since start()
}
```

No `getStats()` on the runner — access via `runner.strategy.getStats()`.

### Shutdown sequence

```
1. Stop data-feed (no new candle/tick events)
2. Stop strategy (disposes scanners — no new signals)
3. Drain executor queue (leave-open) OR cancel all pending (close-all)
   — shutdown behavior affects this step, not just step 4
4. Handle open positions per config:
   - leave-open: skip
   - close-all: for each open position, submit market exit, await fill
5. Disconnect exchange (closes both WebSocket connections)
```

### Trade persistence

Runner subscribes to `position:closed` and writes to trade store:
```typescript
bus.on('position:closed', ({ trade }) => {
  tradeStore.insertTrade(this.strategy.name, trade);
});
```

### Orphan position detection (3a-hardened)

On startup, call `exchange.getPositions()`. If orphaned positions exist from a previous run, refuse to start (override with `--force`). A scalper restarting with an unknown open position from 3 hours ago is a risk scenario.

### Observability (day one)

- Structured JSON logging: every order, fill, signal, risk rejection, connection event
- 30s heartbeat: uptime, wsConnected, openPositions, pendingOrders, `lastCandleAge`
- `lastCandleAge > 2 × candlePeriod` = stale data detection (catches silent WebSocket death)

---

## 3c. Advanced slippage & fills (deferred)

Design after parity-checker provides calibration data showing how the fixed-bps model diverges from reality.

- **Orderbook-based slippage**: Walk the book to estimate fill price. Requires order book recovery hardening (full buffer-and-sequence-validate procedure).
- **Proportional slippage**: `slippageBps = baseBps * (quantity / averageVolume)`
- **Calibration loop**: Run parity check → adjust slippage model → re-run sweep → deploy updated params.

---

## 3d. Data persistence

### New `storage` package

SQLite via `bun:sqlite` — zero dependencies, built-in to Bun, handles 26M rows trivially with proper indexing.

**Package design:**
- Depends on `types` only (leaf node in dependency graph)
- Passive service — no event bus dependency, called explicitly
- Usable from any context: runner, parity-checker, arena, CLI tools, one-off scripts

### Schema

```sql
CREATE TABLE candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  close_time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  quote_volume REAL NOT NULL,
  trades INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time)
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  quantity REAL NOT NULL,
  entry_time INTEGER NOT NULL,
  exit_time INTEGER NOT NULL,
  pnl REAL NOT NULL,
  fees REAL NOT NULL,
  slippage REAL NOT NULL,
  hold_time_ms INTEGER NOT NULL,
  exit_reason TEXT NOT NULL,
  metadata TEXT,  -- JSON
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_trades_strategy ON trades(strategy_name, exit_time);
CREATE INDEX idx_trades_symbol ON trades(symbol, exit_time);
```

`PRIMARY KEY` on candles gives dedup for free — `INSERT OR IGNORE` skips duplicates.

### CandleLoader integration

```typescript
const { candles } = createStorage('./data/trading.db');
const loader: CandleLoader = (symbol, tf, start, end) =>
  Promise.resolve(candles.getCandles(symbol, tf, start, end));
```

`bun:sqlite` is synchronous — wraps in `Promise.resolve()` to match the `CandleLoader` type.

### Sync job

`ICandleStore.sync(exchange, symbol, timeframe, since)` fetches missing candles from exchange REST in 1000-candle batches, deduplicates by `openTime`, inserts into SQLite. Run on a cron or before a backtest.

---

## 3e. Evolution & tournament

### `arena` — Parallel strategy tournament

**Architecture:** Shared exchange → one data parser → broadcast to N isolated buses (Option C).

```
Exchange (one connection, real market data)
  └── Source bus ← LiveDataFeed (one parser, receives raw callbacks)
        ├── Bus A ← SimExecutor A ← Strategy(params_1)
        ├── Bus B ← SimExecutor B ← Strategy(params_2)
        ├── Bus C ← SimExecutor C ← Strategy(params_3)
        └── ...N buses
```

**All paper-trade, no live champion.** The arena evaluates, it doesn't trade. All instances see the same fill simulation (SimExecutor with identical fee/slippage model) for apples-to-apples comparison. Real trading happens in live-runner after manual promotion.

**Event forwarding:** Source bus receives `candle:close`, `tick`, `candle:update` from LiveDataFeed. Arena broadcasts each event to all N strategy buses. Each bus has its own SimExecutor (sync fills, same as BacktestExecutor) → complete isolation.

```typescript
interface ArenaConfig {
  exchangeConfig: ExchangeConfig;     // live or testnet (for real market data)
  simExchangeConfig: ExchangeConfig;  // backtest-sim (for paper fills)
  symbols: string[];
  timeframes: Timeframe[];
  factory: StrategyFactory;
  paramSets: Record<string, number>[];  // N param vectors to run
  evaluationWindowMs: number;
}

interface ArenaRanking {
  params: Record<string, number>;
  metrics: PerformanceMetrics;
  trades: TradeRecord[];
}

interface IArena {
  start(): Promise<void>;
  stop(): Promise<void>;
  getRankings(): ArenaRanking[];
  addInstance(params: Record<string, number>): void;
  removeInstance(params: Record<string, number>): void;
}
```

### `evolver` — Evolutionary parameter selection

**Mutation model:** Proportional — `newValue = oldValue * (1 + gaussian(0, mutationRate))`. Scales naturally across different param magnitudes. Clamp to bounds and snap to step after mutation.

```typescript
interface ParamSpec {
  min: number;
  max: number;
  step?: number;  // 1 for integers, 0.001 for percentages, undefined for continuous
}

type ParamBounds = Record<string, ParamSpec>;

interface EvolverConfig {
  paramBounds: ParamBounds;
  populationSize: number;
  survivalRate: number;             // 0.5 = keep top 50%
  mutationRate: number;             // 0.1 = 10% perturbation
  eliteCount: number;               // 1 = top 1 survives unmutated
  evaluationWindowMs: number;       // passed through to arena
  stagnationGenerations: number;    // widen mutation after N flat generations
  stagnationMutationRate: number;   // wider rate during stagnation (e.g., 0.3)
  scorer: SweepScorer;
}

interface IEvolver {
  start(initialParams: Record<string, number>[]): Promise<void>;
  stop(): Promise<void>;
  readonly generation: number;
  readonly bestParams: Record<string, number>;
  readonly bestMetrics: PerformanceMetrics;
  onGenerationComplete(cb: (rankings: ArenaRanking[]) => void): void;
}
```

**Key decisions:**
- **No crossover** — mutation-only sufficient for 5-15 params
- **Seed from sweep results** — top 10, mutated 4-5× each for ~50 starting population
- **Elitism**: Top 1 survives unmutated, but stats reset (must re-prove itself)
- **Full reset** each evaluation window — prevents survivorship bias
- **Evaluation window**: 24-48h for 1m scalpers (enough trades to be meaningful, short enough for regime adaptation)
- **Stagnation detector**: Widen mutation rate after N flat generations, reset on improvement
- **Promotion**: Manual operator approval. Never auto-deploy from arena to live.

`onGenerationComplete` callback for logging — not a bus event (evolver is an outer loop, not a pipeline component).

### `parity-checker` — Backtest vs reality

**Batch job**, run daily/weekly. Not continuous.

```typescript
interface ParityResult {
  period: { startTime: number; endTime: number };

  matched: Array<{
    live: TradeRecord;
    backtest: TradeRecord;
    entryPriceDiffBps: number;    // positive = live paid more
    exitPriceDiffBps: number;
    pnlDiff: number;
    slippageDiff: number;
    feeDiff: number;
    exitReasonMatch: boolean;
  }>;

  liveOnly: TradeRecord[];
  backtestOnly: TradeRecord[];

  summary: {
    matchRate: number;
    meanEntryDeviationBps: number;
    meanPnlDeviation: number;
    pnlCorrelation: number;
    backtestOverestimatesPnl: boolean;
  };
}

interface IParityChecker {
  compare(
    strategyName: string,
    factory: StrategyFactory,
    params: Record<string, number>,
    period: { startTime: number; endTime: number },
  ): Promise<ParityResult>;
}
```

**Matching:** Fuzzy key `(symbol, side, entryTime ± finest candle period)`. Tolerance scales with timeframe — 60s for 1m scalper, 4h for 4h strategy.

**Three categories:**
- **Matched pairs**: Expected — measures fill quality (slippage model accuracy)
- **Live-only**: Rare — usually data differences between stored and live candles
- **Backtest-only**: Dangerous — trades backtest says you should have taken but didn't. Usually missed candles during disconnect or rate-limit-suppressed signals. High count = backtest overestimates opportunity.

**Calibration loop:** `backtestOverestimatesPnl` → increase fixed-bps slippage → re-sweep with calibrated model → deploy updated params. This closes the backtest-to-live gap.

**Dependencies:** types, backtest-engine, reporting, storage. No bus.

---

## 3f. Sweep parallelism (Bun workers)

**Constraint:** `StrategyFactory` is a function with closures — can't be serialized across worker boundaries via `postMessage`.

**Solution:** Workers import the factory from a module path. Each worker is fully independent.

```typescript
type SweepScorerName = 'profitFactor' | 'sharpe' | 'expectancy' | 'winRate';

interface ParallelSweepConfig {
  factoryModulePath: string;        // './strategies/ema-crossover.ts'
  factoryExportName?: string;       // default: 'factory'
  backtestConfig: BacktestConfig;
  exchangeConfig: ExchangeConfig;   // backtest-sim variant
  dbPath: string;                   // SQLite path — each worker opens own connection
  maxConcurrency?: number;          // default: os.cpus().length
  scorer?: SweepScorerName;
}
```

**Worker lifecycle:**
```
Main thread:
  1. Compute cartesian product of grid
  2. Spawn min(gridSize, maxConcurrency) workers
  3. Send { factoryModulePath, params, config, dbPath, scorer } to each
  4. As workers complete, send next params to idle workers
  5. Collect BacktestResult[], sort, return SweepResult[]

Worker:
  1. const { [exportName]: factory } = await import(modulePath)
  2. const { candles } = createStorage(dbPath)  // own SQLite connection
  3. const loader = (s, tf, start, end) => Promise.resolve(candles.getCandles(s, tf, start, end))
  4. const engine = createBacktestEngine(loader, exchangeConfig)
  5. const result = await engine.run(factory, params, config)
  6. postMessage(result)  // BacktestResult is plain data, serializes fine
```

**Two separate APIs** — don't unify behind `ISweepEngine`:
```typescript
// Sequential (existing — tests, small grids)
const sweep = createSweepEngine(engine);
await sweep.run(factory, grid, config);

// Parallel (new — large grids)
const sweep = createParallelSweepEngine(parallelConfig);
await sweep.run(grid);
```

SQLite handles concurrent readers — each worker opens its own connection, reads are lock-free. OS page cache means candle data loaded from disk once.

`factoryModulePath` resolved from project root (Bun workers inherit CWD).

---

## 3g. Observability

### Day-one (ships with 3a-minimal)

**Structured JSON logging** — runner subscribes to key bus events:
```typescript
const eventsToLog = [
  'order:submitted', 'order:filled', 'order:rejected',
  'signal', 'position:opened', 'position:closed',
  'risk:breach', 'exchange:connected', 'exchange:disconnected',
] as const;
for (const event of eventsToLog) {
  bus.on(event, (data) => logger.info({ event, ...data }));
}
```

**Heartbeat** (30s interval):
```typescript
setInterval(() => {
  logger.info({
    event: 'heartbeat',
    uptime: Date.now() - startTime,
    wsConnected: exchange.isConnected(),
    openPositions: strategy.positionManager?.getOpenPositions().length,
    pendingOrders: executor.getPendingCount(),
    lastCandleAge: Date.now() - lastCandleTimestamp,
  });
}, 30_000);
```

`lastCandleAge > 2 × candlePeriod` = stale data (catches silent WebSocket death that produces zero log lines).

### Deferred

- **CLI dashboard**: Rich TUI with real-time positions, PnL, signal buffer, risk state, connection status
- **Alerting**: Kill switch → Telegram/Discord notification. Connection down > N min → alert. Drawdown approaching threshold → warning.
- **Metrics aggregation**: Prometheus/StatsD if needed

The structured JSON log is the observability primitive — everything else is a consumer.

---

## Phase 3 dependency order

```
3a-minimal: exchange-client (binance-testnet) + LiveDataFeed + LiveExecutor + LiveRunner
  → validate end-to-end flow on testnet

3a-hardened: reconnection, hot-swap, gap backfill, response-based rate sync, safety stops
  → production-grade connection handling

3b: live-runner finalization (shutdown behaviors, orphan detection, health checks)
  → can run strategies on production

3c: slippage models (orderbook-based, proportional) + order book recovery hardening
  → improves backtest accuracy (deferred until parity data exists)

3d: storage package (SQLite candle store + trade logs)
  → required for parity-checker and long-running arena

3e: arena + evolver + parity-checker
  → the evolutionary loop

3f: sweep parallelism (Bun workers)
  → performance optimization, independent of other work

3g: observability (CLI dashboard, alerting)
  → quality of life, independent of other work
```

3a-minimal is the critical path. Everything after 3a-hardened can be parallelized.
