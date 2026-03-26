# Architecture Decisions

This document records the architectural decisions made for the trading bot monorepo. Each decision includes the context, options considered, and rationale.

---

## ADR-1: Floating-point precision

**Decision:** Use `number` (float64) for all numeric fields. Handle accumulated drift with `KahanSum` in the `reporting` package.

**Context:** Every price, quantity, PnL, and balance field could use IEEE 754 doubles, string-encoded decimals, integer scaling, or a decimal math library. Over thousands of trades in a backtest, rounding errors accumulate in running totals. Performance metrics (Sharpe, profit factor) compound the drift.

**Rationale:** Binance prices use at most 8 decimal places — well within float64's 15-16 significant digits. Individual trade math is exact. The risk is accumulated PnL across thousands of trades. Rather than adding `decimal.js` complexity to every arithmetic operation in every package, we use Kahan compensated summation in the one place accumulation happens: `reporting`. This eliminates drift in equity curves, total PnL, total fees, and parity-checker diffs.

**Revisit trigger:** If parity-checker drift exceeds 1 basis point despite Kahan summation.

---

## ADR-2: Synchronous event bus

**Decision:** The event bus is synchronous. All handlers must be synchronous (`() => void`, never `() => Promise<void>`). Async work is enqueued via sync `submit()` methods.

**Context:** A synchronous event bus is critical for deterministic backtesting — handlers run inline, not deferred, so event ordering is guaranteed. But in live trading, if a handler triggers an async network call (order placement), a synchronous `emit()` blocks the entire pipeline until the chain completes.

**Rationale:** The event bus stays sync in both modes. Handlers that need to trigger async work (e.g., placing an order) call a sync `submit()` method on `IOrderExecutor` that enqueues the work and returns a `SubmissionReceipt` immediately. The actual exchange call happens on the executor's internal async queue. Results come back as `order:filled` / `order:rejected` events on the event bus.

**Consequences:**

- `IOrderExecutor.submit()` is synchronous — returns `SubmissionReceipt`, not `Promise<OrderResult>`
- `IPositionManager` methods are all sync — it never awaits an order
- Position lifecycle has explicit `PENDING_ENTRY` and `PENDING_EXIT` states to track in-flight orders
- In backtest-sim, `submit()` processes orders immediately and synchronously (simulated fill, instant event emission) — same event sequence, zero delay
- In live mode, there's real delay between `order:submitted` and `order:filled`

**Backtest re-entrancy (implementation pattern):** Because backtest-sim processes fills synchronously inside `submit()`, the calling handler is re-entered while still on the call stack. Example: position-manager's `signal` handler calls `submit()` → backtest-sim emits `order:filled` → position-manager's `order:filled` handler fires — all within the same `signal` handler invocation. This is safe _if and only if_ the following rule is followed:

> **State-before-emit rule:** In any event handler, update all internal state before emitting any events or calling any method that may emit (including `submit()`). Never emit first and update after. This ensures that if the emit triggers synchronous re-entry, the component's state is already consistent.

Correct ordering:

```
// RIGHT — state is consistent before submit may re-enter
this.state.set(symbol, 'PENDING_ENTRY');
this.executor.submit(request);  // may synchronously fire order:filled
```

Incorrect ordering:

```
// WRONG — order:filled handler fires with stale state
this.executor.submit(request);  // fires order:filled, handler sees IDLE
this.state.set(symbol, 'PENDING_ENTRY');  // too late
```

This rule surfaces bugs early: in live mode, wrong ordering is a rare race condition; in backtest mode, it's an immediate state machine violation. Backtest exposing re-entrancy is a feature, not a problem.

Fills must NOT be deferred (no `queueMicrotask`, no post-emit queue). Deferring creates a window where the system is in an impossible state — order submitted but not processed while the next candle arrives. In live trading that window is real and unavoidable; in backtesting it's artificial and must not exist.

---

## ADR-3: Connection lifecycle events

**Decision:** Exchange adapters handle reconnection internally and announce state changes via typed events on the event bus: `exchange:connected`, `exchange:disconnected`, `exchange:reconnecting`, `exchange:gap`.

**Context:** WebSocket connections drop — Binance kills idle connections after 24h, network blips happen. Consumers need to know when data is stale, when gaps exist, and when the connection recovers. Options ranged from silent auto-reconnect to per-subscription status callbacks to event bus events.

**Rationale:** Connection state is a system-wide concern, not a per-subscription concern. Multiple components need to react: data-feed backfills gaps, risk-manager freezes entries during disconnects, live-runner logs it. Event bus is where system-wide concerns belong.

**Event payloads carry enough detail to be actionable:**

- `stream` field identifies which WebSocket dropped (Binance uses separate connections per stream type)
- `exchange:gap` includes `fromTimestamp` / `toTimestamp` so data-feed can backfill precisely
- `exchange:reconnecting` includes `attempt` count for exponential backoff monitoring
- `exchange:disconnected` includes `reason` for diagnostics

**Backtest-sim never emits connection lifecycle events** — the connection is always perfect.

---

## ADR-4: Discriminated union exchange config

**Decision:** `ExchangeConfig` is a discriminated union on `type`. The factory takes a single `config` argument — no separate `ExchangeType`.

**Context:** A flat config struct with all optional fields means backtest-sim has unused `apiKey`/`apiSecret` and live has unused backtest fields. Adding exchanges (Bybit, OKX) would pile on exchange-specific optionals.

**Rationale:** Discriminated unions are TypeScript's bread and butter. The compiler enforces that when `type === 'binance-live'`, `apiKey` and `apiSecret` exist. When `type === 'backtest-sim'`, `feeStructure` and `slippageModel` exist. No runtime checks needed, impossible to accidentally pass backtest config to a live adapter.

**Structure:**

- `ExchangeConfigBase` — shared fields (`defaultLeverage`, `recvWindow`)
- Each variant intersects the base with its own required fields
- `BacktestConfig` is slimmed to run-level concerns (`startTime`, `endTime`, `symbols`, `timeframes`) — fee/slippage config lives on the `backtest-sim` variant because the exchange adapter simulates fills

---

## ADR-5: Raw streams in IExchange, semantics in data-feed

**Decision:** `IExchange` subscription methods mirror what the exchange actually sends — no filtering or aggregation. `data-feed` owns all semantic interpretation.

**Context:** Binance's kline stream sends every update to the forming candle, not just the close. The order book comes as diffs, not full snapshots. Something needs to filter/aggregate — the question is where.

**Rationale:** The exchange adapter should be a thin wrapper around the exchange's actual API. Putting candle-close filtering or book maintenance in the adapter splits the logic across two packages and makes data-feed's role unclear.

**Concrete changes:**

- `subscribeCandleClose()` → `subscribeCandles()` — fires on every kline update (both `isClosed: false` and `isClosed: true`)
- `subscribeOrderBook()` → `subscribeOrderBookDiff()` — fires on depth diffs
- `data-feed` filters `isClosed` and routes to `candle:close` vs `candle:update` events
- `data-feed` maintains a local `OrderBookSnapshot` by applying diffs to an initial REST snapshot
- `data-feed` listens for `exchange:gap` events and backfills via REST `getCandles()`
- `data-feed.getOrderBook(symbol)` exposes current book state

---

## ADR-6: Indicator and scanner factory pattern

**Decision:** No `clone()` on indicators. Use `IndicatorFactory` and `ScannerFactory` functions to create fresh instances.

**Context:** `clone()` on an interface means every implementation must deep-copy itself — including nested indicator chains (EMA feeding EMA). Missing one nested reference means shared mutable state between "independent" backtest runs, a silent bug.

**Rationale:** A factory is a function `(config) => IIndicator`. Scanners hold factories (not instances) in their config. Each backtest run / parallel strategy calls the factory to get fresh instances. No shared state is possible — there's nothing to share.

**Consequences:**

- `IIndicator` has `readonly config: TConfig` — exposed for logging, reporting, sweep output
- `IIndicator` has `reset()` — for sequential reuse within a single run
- `IScannerConfig.indicators` holds `Record<string, IndicatorFactory>`, not instances
- `StrategyConfig` holds instances (created per-run by the engine via factories)

---

## ADR-7: Reactive risk manager with structured results

**Decision:** The risk manager subscribes to the event bus and builds its own state reactively. `checkEntry` takes a signal + entry price — balance and position state are internal. Returns a structured `RiskCheckResult` with programmatic rule identification, severity, and computed position quantity.

**Context:** The original `checkEntry(signal, balance): string | null` had two problems. First, the risk checks (max concurrent positions, daily trade count, cooldown after loss) require state beyond just the balance — current positions, trade history, timestamps. The caller would need to provide all of this, creating an implicit contract. Second, a string rejection gives a log message but no programmatic branching — position-manager can't distinguish "kill switch, stop everything" from "cooldown, try again later" without parsing strings.

**Rationale:** In an event-driven architecture, components build state from events. The risk manager listens to `order:filled`, `position:opened`, `position:closed`, and reconstructs balance from `initialBalance + Σ(trade.pnl)`. It already knows the current balance, open position count, today's trades, last loss timestamp. `checkEntry(signal, entryPrice)` needs only the signal and the current market price (for position sizing). The entry price comes from position-manager (which tracks last tick price) — the risk manager doesn't subscribe to ticks itself.

The structured return type lets consumers branch on severity without knowing the full rule taxonomy:

```typescript
// These live in @trading-bot/types (not risk-manager) because
// TradingEventMap in event-bus references RiskRule for 'risk:breach' events.
export type RiskRule =
  | 'MAX_POSITION_SIZE'
  | 'MAX_CONCURRENT'
  | 'MAX_DAILY_LOSS'
  | 'MAX_DRAWDOWN'
  | 'MAX_DAILY_TRADES'
  | 'COOLDOWN';

export type RiskSeverity = 'REJECT' | 'KILL';

export type RiskCheckResult =
  | { allowed: true; quantity: number }
  | { allowed: false; rule: RiskRule; reason: string; severity: RiskSeverity };
```

`REJECT` = this entry is blocked but keep scanning (cooldown, max concurrent). `KILL` = stop all trading (max daily loss, max drawdown). The risk manager owns the severity mapping because it owns the risk policy. When `allowed: true`, `quantity` is the position size computed from `balance * maxPositionSizePct * leverage / entryPrice`.

**Consequences:**

- `risk-manager` now depends on `event-bus` (subscribes to events) — was previously `types` only
- `checkEntry(signal, entryPrice)` — entryPrice from position-manager's last tick; balance is internal state
- `RiskCheckResult.allowed: true` includes `quantity` — risk-manager owns all sizing inputs
- `RiskConfig` gains `leverage: number` (default 1) and `initialBalance: number`
- `isKillSwitchActive()` stays — quick probe without submitting a fake signal
- `recordTrade()` is removed — the risk manager hears trades through events, not manual calls
- `reset()` stays — needed between backtest runs

---

## ADR-8: Constructor-injected reactive components

**Decision:** All components that react to events receive their dependencies (event bus, services) via constructor and subscribe immediately. No `init()` methods, no imperative `onX` callbacks. Public interfaces are query methods + lifecycle only.

**Context:** Position-manager had `onTick(tick)` and `onSignal(signal)` — imperative methods that a caller must invoke. But in an event-driven architecture, the caller would just be subscribing to events and forwarding them, re-inventing event routing outside the bus. Additionally, `onSignal` was async (to await order placement), violating ADR-2's sync handler rule.

**Rationale:** If a component reacts to events, it should own its subscriptions. Constructor injection means the component is ready the moment it exists — no "did you remember to call init?" failure mode. The event bus is the router; components don't need intermediaries forwarding events to them.

**The universal pattern:**

```
Constructor: receives IEventBus + service deps → subscribes immediately
Public interface: query methods only (getState, hasX, isY)
Imperative queries: synchronous calls another component needs (e.g., riskManager.checkEntry)
Lifecycle: dispose() to unsubscribe
```

**Applied to each reactive component:**

- **position-manager** — Constructor receives `(eventBus, orderExecutor, riskManager, config)`. Subscribes to `tick`, `signal`, `order:filled`, `order:rejected`. Public interface is query methods (`getState`, `hasOpenPosition`, `getOpenPositions`). When it hears a `signal`, it calls `riskManager.checkEntry(signal, lastTickPrice)` synchronously — if allowed, uses `result.quantity` in the `OrderRequest` passed to `orderExecutor.submit()`.
- **risk-manager** — Constructor receives `(eventBus, config)`. Subscribes to `order:filled`, `position:opened`, `position:closed`. Exposes `checkEntry(signal, entryPrice)` as a synchronous query and `isKillSwitchActive()`. Tracks balance internally from `initialBalance + Σ(trade.pnl)` via `position:closed` events.
- **scanner** — Constructor receives `(eventBus, config)` where config contains indicator factories. Subscribes to `candle:close`. Emits `scanner:signal` events on the bus (strategy merges these into actionable `signal` events — see ADR-9). Public interface is just `readonly name` and `readonly config`. No `onCandleClose()` return value — signals flow through events.
- **strategy** — Constructor receives all component instances (already wired to the bus) plus `signalMerge` and `signalBufferWindowMs`. Subscribes to `scanner:signal`, applies merge logic, emits `signal` when actionable (see ADR-9). `start()` / `stop()` manage lifecycle.

**Exception:** `checkEntry` on risk-manager is an imperative synchronous query, not an event reaction. Position-manager calls it inline during its `signal` handler. This is correct — it's a decision gate, not a state update.

**Testing consequence:** Unit tests emit events on a test bus and assert that the right output events (or state changes) result. This tests the real wiring, not artificial `onX` method calls.

**Consequences:**

- `scanner` now depends on `event-bus` (was `types, indicators` only)
- All `onX` methods removed from interfaces — replaced by constructor subscriptions
- `dispose()` added to reactive components for cleanup (unsubscribe from bus)

---

## ADR-9: Multi-timeframe composition via signal routing

**Decision:** Scanners stay single-timeframe. Multi-timeframe strategies compose multiple scanners. Signals are routed through a two-tier event system: `scanner:signal` (raw) → strategy merge → `signal` (actionable).

**Context:** Most real strategies need multiple timeframes — e.g., 4h EMA for trend direction, 15m RSI for entry timing. The scanner interface binds to a single timeframe. A scanner could subscribe to multiple timeframes, but then its indicator set becomes ambiguous.

**Rationale:** Single-timeframe scanners are simpler to test, simpler to reason about, and composable. The strategy layer is already the composition point — extending it to hold multiple scanners and a signal-merging rule is natural.

**Signal routing:**

```
scanner → emits 'scanner:signal' (raw, per-scanner)
strategy → subscribes to 'scanner:signal', applies merge, emits 'signal' (actionable)
position-manager → subscribes to 'signal' (only actionable ones)
```

For a single-scanner strategy, the merge is a pass-through: `(trigger) => trigger`. For multi-scanner, it's a buffered time-window merge. Position-manager doesn't change — it only sees `signal` events.

**The `SignalMerge` function:**

```typescript
type SignalMerge = (trigger: Signal, buffer: SignalBuffer) => Signal | null;
```

- `trigger`: the `scanner:signal` that just arrived (which scanner, which action)
- `buffer`: `Map<scannerName, Signal[]>` — recent signals from all scanners within a configurable time window
- Returns an actionable signal or null (not ready yet)

Example merge for "4h trend + 15m entry": only emit when the 4h scanner's most recent signal is `ENTER_LONG` and the 15m scanner just emitted `ENTER_LONG` within the buffer window.

**Consequences:**

- `StrategyConfig` has `scanners: IScanner[]` (plural), `signalMerge`, `signalBufferWindowMs` — no single `timeframe`
- Strategy is now reactive (subscribes to `scanner:signal`, emits `signal`) — consistent with ADR-8
- `TradingEventMap` adds `'scanner:signal'` alongside `'signal'`
- Scanners emit `'scanner:signal'`, not `'signal'` directly

---

## ADR-10: Runner owns environment, factory builds strategy

**Decision:** The runner (backtest-engine or live-runner) creates the environment — bus, exchange, executor, data-feed. The `StrategyFactory` receives these as `StrategyDeps` and builds the strategy-specific components (scanners, risk manager, position manager, signal merge) wired to them.

**Context:** `StrategyFactory` originally created its own `EventBus`. But the backtest-engine needs to drive a data-feed that emits `candle:close` events on the same bus the strategy is wired to. If the factory creates the bus internally, the engine has no way to get onto it.

**Rationale:** What changes between backtest and live for the _same strategy_ is the environment:

| Component      | Backtest      | Live             |
| -------------- | ------------- | ---------------- |
| EventBus       | one per run   | one per strategy |
| IExchange      | backtest-sim  | binance-live     |
| IOrderExecutor | sync fill sim | async queue      |
| IDataFeed      | replay feed   | WebSocket feed   |

What _doesn't change_: scanners, risk rules, position management config, signal merge logic. The factory builds the second group; the runner provides the first.

**Revised factory signature:**

```typescript
interface StrategyDeps {
  bus: IEventBus;
  exchange: IExchange;
  executor: IOrderExecutor;
}
type StrategyFactory = (params: Record<string, number>, deps: StrategyDeps) => IStrategy;
```

**Backtest-engine run flow:**

```
1. create bus = new EventBus()
2. create exchange = createExchange({ type: 'backtest-sim', ... })
3. create executor = new BacktestExecutor(bus, exchange)
4. for each symbol × timeframe: load candles via CandleLoader
5. create dataFeed = new ReplayDataFeed(bus, candles)
6. subscribe to position:closed on bus (collects TradeRecord[])
7. call factory(params, { bus, exchange, executor }) → strategy
8. start dataFeed → pumps candles → bus → scanner → signal → position-manager → executor
9. after replay: call computeMetrics(trades) from reporting → BacktestResult
```

Live-runner does the same with different deps (binance-live exchange, async executor, WebSocket data-feed). Same factory, different environment.

**Consequences:**

- `StrategyFactory` does NOT create bus, exchange, or executor — runner does
- Bus isolation between runs is enforced by the runner, not the factory
- `IBacktestEngine.run()` takes `(factory, params, config)`, not a finished `IStrategy`
- `backtest-engine` depends on `order-executor`, `data-feed`, and `reporting` (creates instances, computes metrics)
- `live-runner` depends on `order-executor` and `data-feed`

---

## Dependency graph

Direction is strictly downward. No circular dependencies (enforced by Nx boundary rules).

```
types                          (no deps)
├── event-bus
├── exchange-client
├── indicators
├── reporting
│
├── risk-manager               (types, event-bus)
├── data-feed                  (types, event-bus, exchange-client)
├── order-executor             (types, event-bus, exchange-client)
│
├── position-manager           (types, event-bus, order-executor, risk-manager)
├── scanner                    (types, event-bus, indicators)
│
├── strategy                   (types, event-bus, exchange-client, order-executor, scanner, position-manager, risk-manager)
│
├── backtest-engine            (types, event-bus, exchange-client, data-feed, order-executor, strategy, reporting)
├── live-runner                (types, event-bus, exchange-client, data-feed, order-executor, strategy)
├── sweep-engine               (types, backtest-engine, strategy)
│
├── arena                      (types, live-runner, reporting)
├── parity-checker             (types, backtest-engine, reporting)
│
└── evolver                    (types, arena)
```

## Critical rules

1. **No `any` anywhere.** Use `unknown` + type narrowing if truly needed.
2. **Every package exports only through `src/index.ts`** barrel file.
3. **Dependency direction is strictly downward.** Enforced by `@nx/enforce-module-boundaries`.
4. **No circular dependencies.**
5. **Interfaces, not classes, at package boundaries.** Internal implementation can use classes.
6. **Event bus handlers are synchronous.** Async work goes through `submit()` patterns.
7. **IExchange mirrors the exchange API.** Semantic logic lives in data-feed.
8. **Factories, not clone().** Fresh instances via factory functions for parallelism.
9. **Reactive risk manager.** Builds state from events, not from caller-provided context.
10. **Constructor-injected reactivity.** No `onX` callbacks; components self-subscribe to the bus.
11. **Two-tier signal routing.** Scanners emit `scanner:signal`; strategy merges and emits `signal`. Position-manager never sees raw scanner output.
12. **Runner owns environment.** Bus, exchange, executor, data-feed are created by the runner and injected into the factory via `StrategyDeps`.
