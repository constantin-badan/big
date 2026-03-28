# Codebase Review — Full Issue Registry

**Scope:** 20 packages, 123 TypeScript files. Every source file, test case, and decision branch reviewed line-by-line.

---

## P0 — Confirmed Bugs (Money / Correctness)

### ~~1. Balance deduction ignores leverage in backtest sim~~ ✅

**Status:** Investigated — the full-notional accounting is actually correct for PnL tracking. With margin-based deduction, round-trip PnL gets divided by leverage. The balance going negative during open positions is expected. **Fixed the real sub-issue: LIMIT orders now use maker fee rate instead of taker** (#9).

---

### ~~2. Reconnect loop continues indefinitely after kill signal~~ ✅

**Fixed:** Added `return;` after `onReconnectExhausted` to exit the reconnect loop.

---

### ~~3. `intentionalDisconnect` flag never reset — breaks auto-reconnect permanently~~ ✅

**Fixed:** Reset `intentionalDisconnect = false` at the start of `open()`.

---

### ~~4. `checkEntry()` does not reset daily counters~~ ✅

**Fixed:** Added `this.checkAndResetDaily(signal.timestamp)` at the top of `checkEntry()`.

---

### ~~5. Position stuck in PENDING_EXIT when exit fills without entry order~~ ✅

**Fixed:** Added `this.resetToIdle(symState)` before the early return.

---

### ~~6. Trailing stop misses breach on activation candle~~ ✅

**Fixed:** Changed activation to fall through to breach check instead of returning `'ACTIVATED'` immediately.

---

### ~~7. `sessionLogon()` failure leaves WS open but unauthenticated~~ ✅

**Fixed:** Wrapped both `sessionLogon()` and `getBalance()` in a single try/catch that closes the connection on any failure.

---

### ~~8. `LiveExecutor.hasPending()` is broken — in-flight orders invisible~~ ✅

**Fixed:** Replaced `Set<string>` with `Map<string, string>` (clientOrderId → symbol). `hasPending()` now iterates the map values to check by symbol.

---

### ~~9. LIMIT orders charged taker fee in backtest sim~~ ✅

**Fixed:** Fee rate now selects `maker` for LIMIT orders, `taker` for all others.

---

### ~~10. MarginGuard silently ignores positions without mark price~~ ✅

**Fixed:** Now emits an `'error'` event when a symbol has open positions but no mark price, making the gap visible to monitoring.

---

### ~~11. `Evolver.evolve()` crashes on empty rankings~~ ✅

**Fixed:** Added `if (survivors.length === 0)` guard before the fill loop, scheduling next generation and returning early.

---

### ~~12. `Evolver.buildInitialPopulation()` can infinite-loop~~ ✅

**Fixed:** Added `sourceIdx > populationSize * 100` safety break to the `buildInitialPopulation` while loop.

---

## P1 — Security & Production Readiness

### 13. No rate limiting on exchange REST requests

**File:** `packages/exchange-client/src/binance/adapter.ts`

No throttling for any REST calls (`getBalance()`, `getPositions()`, `getFees()`, `getCandles()`, etc.). Binance enforces hard rate limits (1200 request weight / minute). The `LiveExecutor` has its own rate limiter for WS API order placement, but all REST calls from the adapter are unthrottled. Spamming will trigger IP bans.

**Fix:** Add a shared rate limiter (token bucket) for REST requests.

---

### 14. `emittedFills` dedup set grows unbounded

**File:** `packages/exchange-client/src/binance/adapter.ts:81`

`private readonly emittedFills = new Set<string>()` accumulates every `orderId:status` pair forever. In a long-running process with thousands of orders, this is a memory leak.

**Fix:** Use a bounded LRU cache or time-based TTL (1 hour is more than enough for dedup purposes).

---

### 15. REST client has no request timeout

**File:** `packages/exchange-client/src/binance/rest-client.ts:16,32`

`fetch()` calls have no `AbortSignal` timeout. A hung network connection blocks indefinitely. Both `restGet()` and `restPost()` are affected.

**Fix:** Add `AbortController` with a configurable timeout (e.g., 30 seconds).

---

### 16. Race condition: concurrent market data connections

**File:** `packages/exchange-client/src/binance/adapter.ts:465-468`

Two rapid `subscribe*()` calls can both see `marketDataConn === null` and both call `connectMarketDataWs()` via fire-and-forget `void`. This creates duplicate WebSocket connections.

**Fix:** Add a `marketDataConnecting` flag or promise mutex to prevent concurrent connection attempts.

---

### 17. LiveExecutor retries bypass rate limiter

**File:** `packages/order-executor/src/live-executor.ts:193`

`processItem()` calls itself recursively on transport errors without calling `consumeToken()` first. During error storms (exchange returning 5xx), retries can violate Binance rate limits.

**Fix:** Call `consumeToken()` before each retry, or queue retries back into the main drain loop.

---

### 18. `RateLimitError` is exported but never used

**File:** `packages/exchange-client/src/errors.ts:8`

The class is defined and exported but never thrown or constructed anywhere in the codebase. Dead code that implies rate limiting exists when it doesn't.

**Fix:** Remove it, or implement rate limiting that uses it.

---

## P2 — Design Issues & Robustness

### 19. EventBus: handlers added during emit() fire in same cycle

**File:** `packages/event-bus/src/event-bus.ts:39-50`

ES2015 `Set` iteration visits entries added during iteration. A handler that calls `bus.on()` for the same event during an `emit()` will cause the new handler to fire in the current emit cycle. No re-entrancy depth guard exists, so infinite recursion is possible if a handler emits the same event it's listening to.

**Fix:** Snapshot the handler set before iterating: `const snapshot = [...set]`.

---

### 20. EventBus errors only logged to console

**File:** `packages/event-bus/src/event-bus.ts:43-49`

Handler exceptions are caught and `console.error`'d. No `'error'` event is emitted, no return value indicates failure. In production, errors vanish unless console output is piped to a logger.

---

### 21. Scanner `config.symbols` is never used for filtering

**File:** `packages/scanner/src/scanner.ts:34-71`

The `symbols` array in `IScannerConfig` is stored but never consulted during `handleCandleClose`. The scanner processes candles for any symbol that arrives on the bus, not just configured ones. The field is dead code within the scanner.

---

### 22. Position-manager ignores `timeframe` in `onCandleClose`

**File:** `packages/position-manager/src/position-manager.ts:126`

The `timeframe` parameter is destructured but never checked. If `candle:close` events arrive for multiple timeframes (1m, 5m, 1h), SL/TP is evaluated redundantly for each timeframe on the same position.

---

### 23. Dead config fields in `PositionManagerConfig`

**File:** `packages/position-manager/src/position-manager.ts`

Three config fields from the `PositionManagerConfig` interface are never read:
- `entryOrderType` — entry orders are hardcoded to `'MARKET'` at line ~228.
- `safetyStopEnabled` — never referenced.
- `safetyStopMultiplier` — never referenced.

---

### 24. Dead state in risk-manager: `lastTradeTimestamp`

**File:** `packages/risk-manager/src/risk-manager.ts:23,107`

`lastTradeTimestamp` is written on every `order:filled` event but never read anywhere. The cooldown logic uses `lastTradeClosedAt` (set in `position:closed`), not `lastTradeTimestamp`. The field is dead state.

---

### 25. `maxDailyLossPct = 0` and `maxDrawdownPct = 0` immediately trigger kill switch

**File:** `packages/risk-manager/src/risk-manager.ts:182-207`

Both values pass config validation (>= 0 is allowed). But `dailyPnl.value <= 0` is `0 <= 0 = true`, and `drawdown >= 0` is `0 >= 0 = true`, so `checkEntry()` immediately activates the kill switch on the first call. The system is unusable with these configs but no error is raised.

**Fix:** Either reject `= 0` in validation or document that 0 means "disabled" and skip the check.

---

### 26. Strategy `stop()` called twice in backtest engine

**File:** `packages/backtest-engine/src/backtest-engine.ts:69+73`

In the happy path, `strategy.stop()` is called at line 69, then the `finally` block calls it again at line 73. The second call is suppressed by try/catch, but strategies that don't handle double-stop gracefully could misbehave.

**Fix:** Remove the `stop()` from line 69 and rely solely on the `finally` block.

---

### 27. No backtest config validation

**File:** `packages/backtest-engine/src/backtest-engine.ts:10-48`

No check that `startTime < endTime`, `symbols` is non-empty, `timeframes` is non-empty, or `initialBalance > 0`. Empty arrays silently produce zero-trade results with no error.

---

### 28. ReplayDataFeed gap detection is non-fatal

**File:** `packages/data-feed/src/replay-data-feed.ts:88-124`

Missing candles emit an `'error'` event but replay continues uninterrupted. The backtest completes "successfully" with incomplete data. The caller has no easy way to detect the data quality issue unless they subscribe to `'error'` events.

---

### 29. Parallel sweep engine: no maxCombinations check, no worker timeout

**File:** `packages/sweep-engine/src/parallel-sweep-engine.ts:42-138`

Unlike the sequential engine (which checks `maxCombinations`), the parallel engine has no safety limit on grid size. Additionally, there is no timeout mechanism — a hung worker causes the entire Promise to never resolve.

---

### 30. `SlippageModel` is not a proper discriminated union

**File:** `packages/types/src/index.ts:349-354`

All fields are optional on all variants. `{ type: 'fixed' }` without `fixedBps`, or `{ type: 'orderbook-based', fixedBps: 5 }`, both compile without error. Should use per-variant required fields.

---

### 31. Market data WsConnection labeled `'kline'` for all stream types

**File:** `packages/exchange-client/src/binance/adapter.ts:310`

The market data `WsConnection` is created with `streamLabel: 'kline'` regardless of actual stream types. Gap events report `stream: 'kline'` even for depth or aggTrade gaps, making gap diagnostics misleading.

---

### 32. Unknown Binance values silently default to `'BUY'`/`'MARKET'`/`'NEW'`

**File:** `packages/exchange-client/src/binance/parsers.ts:187-189`

`ORDER_SIDE_MAP[o.S] ?? 'BUY'` means an unknown order side from Binance silently becomes `'BUY'`. Similarly, unknown type defaults to `'MARKET'` and unknown status to `'NEW'`. In a trading system, silently treating an unknown side as BUY is dangerous.

**Fix:** Throw or log on unknown values rather than defaulting.

---

### 33. `clampAndSnap` with `step=0` produces NaN

**File:** `packages/evolver/src/mutation.ts:32`

`Math.round(x/0)` yields `Infinity`. Then `min + Infinity * 0 = NaN`. No validation against `step <= 0`.

---

### 34. `commissionAsset` hardcoded to `'USDT'`

**File:** `packages/exchange-client/src/binance/parsers.ts:238`

In `parseWsApiOrderResponse()`, `commissionAsset` is always `'USDT'`. Wrong for non-USDT-quoted pairs.

---

### 35. RSI returns 100 for flat prices (all identical closes)

**File:** `packages/indicators/src/rsi.ts:73-79`

When all prices are identical, both `avgGain` and `avgLoss` are 0. The `avgLoss === 0` guard returns 100, suggesting maximum bullishness despite zero price movement. Most implementations return 50 (neutral) for this case.

---

### 36. Dual balance tracking with no reconciliation in backtest

**File:** `packages/backtest-engine/src/backtest-engine.ts:91-94` vs `backtest-sim-exchange.ts:154-158`

`BacktestSimExchange` tracks `balance` via fill-level math (fees + slippage), while `BacktestEngine` computes `finalBalance = initialBalance + Σ(trade.pnl)` from `position:closed` events. These are two independent ledgers. If `trade.pnl` doesn't match the exchange's accounting (e.g., due to the leverage bug #1), the results diverge silently.

**Fix:** Use `exchange.getBalance()` as the authoritative final balance, or add a parity assertion.

---

### 37. Risk-manager kill switch rule persists across daily resets

**File:** `packages/risk-manager/src/risk-manager.ts:130-132`

At day boundaries, `killSwitchActive` is reset for `MAX_DAILY_LOSS`, but `killSwitchRule` is not cleared. Between the reset and the next `checkEntry`, `isKillSwitchActive()` returns false but `killSwitchRule` contains stale data from the previous day.

---

### 38. `Evolver._bestMetrics` stores a reference, not a copy

**File:** `packages/evolver/src/evolver.ts:167`

`this._bestMetrics = topRanking.metrics` stores a direct reference. If the arena later mutates that metrics object, the evolver's `bestMetrics` silently changes. `bestParams` correctly uses `{ ...topRanking.params }` (shallow copy), but `bestMetrics` does not.

---

### 39. LiveExecutor priority queue is dead code

**File:** `packages/order-executor/src/live-executor.ts:100`

The `priority` field on queue items is always set to `false`. No code ever sets it to `true`, and no code reads it to reorder the queue. The priority mechanism has no effect.

---

### 40. `cancelAll()` on LiveExecutor does not cancel exchange orders

**File:** `packages/order-executor/src/live-executor.ts:112-120`

`cancelAll(symbol)` only removes items from the local queue. It does not call `exchange.cancelOrder()` for orders that have already been sent to the exchange and are in-flight. The method name is misleading.

---

### 41. `cartesianProduct` duplicated across two files

**Files:** `packages/sweep-engine/src/sweep-engine.ts:11-30` and `packages/sweep-engine/src/parallel-sweep-engine.ts:14-33`

Identical function duplicated. DRY violation.

---

### 42. Parallel sweep engine uses `navigator.hardwareConcurrency`

**File:** `packages/sweep-engine/src/parallel-sweep-engine.ts:36`

Browser API used in a server-side Bun context. Works due to `?? 4` fallback, but semantically wrong. Should use `require('os').cpus().length` or Bun equivalent.

---

### 43. Evolver non-elite survivor dedup collision causes arena/population mismatch

**File:** `packages/evolver/src/evolver.ts:222-230`

When mutation produces a duplicate key (already in `seen`), the mutated params are still added to the arena but NOT tracked in `newPopulation`. This creates a mismatch between what the evolver thinks the population is and what the arena actually contains.

---

### 44. LiveDataFeed backfill doesn't pass time range to `getCandles()`

**File:** `packages/data-feed/src/live-data-feed.ts:140`

`getCandles(symbol, timeframe, 1000)` fetches the latest 1000 candles, then filters by the gap window. If the gap is older than the latest 1000 candles, it won't be backfilled.

---

### 45. Reporting: drawdown duration tracks from last peak, not longest-drawdown peak

**File:** `packages/reporting/src/metrics.ts:151-157`

`maxDrawdownDuration` is computed as `endTime - peakTime` where `peakTime` is the most recent peak. If an earlier peak produced a longer drawdown, it's not tracked. The metric can underreport the longest drawdown duration.

---

### 46. Position-manager EXIT signals are silently ignored

**File:** `packages/position-manager/src/position-manager.ts:186`

`if (action === 'EXIT') return;` — EXIT signals are completely dropped. Once a position is open, it can only exit via SL, TP, trailing stop, or timeout. There is no signal-driven exit path. This is a deliberate design choice but is undocumented and could surprise strategy authors.

---

### 47. `onOrderRejected` discards the rejection reason

**File:** `packages/position-manager/src/position-manager.ts:268`

The `reason` parameter is destructured but never used — not logged, not stored, not emitted. Silent failure with no observability.

---

### 48. `getOpenOrders()` uses `Date.now()` for `requestTime` instead of actual request start

**File:** `packages/exchange-client/src/binance/adapter.ts:235`

`parseWsApiOrderResponse(item, Date.now())` is called inside `.map()` at response time, not at request start. The `latencyMs` in returned results is ~0, not reflecting actual round-trip latency.

---

### 49. `wsApiRequest()` send failure after `track()` leaks pending request

**File:** `packages/exchange-client/src/binance/adapter.ts:447-448`

If `tradingConn.send()` throws after `requestTracker.track()` has registered the pending promise, the request lingers until the 30-second timeout. No cleanup on send failure.

---

### 50. Evolver config not validated

**File:** `packages/evolver/src/evolver.ts:42-45`

No validation that `populationSize > 0`, `survivalRate ∈ [0,1]`, `eliteCount <= populationSize`, or `evaluationWindowMs > 0`. Invalid configs produce cryptic runtime errors.

---

## P3 — Test Coverage Gaps

### Critical untested code (zero coverage)

| Package | Untested code |
|---------|---------------|
| **exchange-client** | Entire `WsConnection` class (open, close, reconnect loop, delay calculation, maintenance detection). Entire `RestClient` class. Entire `RequestTracker` class. All adapter methods (`connect`, `disconnect`, `placeOrder`, `cancelOrder`, `getOpenOrders`, `getPosition`, `getPositions`, `setLeverage`, `getBalance`, `getFees`). Dedup logic in `emitOrderEvent`. `signPayload`/`signRequest` (only `buildQueryString` is tested). `parseWsApiOrderResponse`, `parseRestOrderBook`. |
| **LiveExecutor** | Entire class: `submit`, `cancelAll`, `hasPending`, `drainQueue`, `processItem`, retry logic, token bucket rate limiter, event handlers, `start`/`stop`. |
| **KahanSum** | Zero tests despite being the only runtime class in `types`. No coverage of `add()`, `reset()`, compensation algorithm, non-finite error throwing, or precision verification. |
| **LiveDataFeed** | Entire backfill flow (`backfillGap`), buffer management during backfill, dedup logic for closed candles, `exchange:gap` event handling, `startMarketDataStream` duck typing. |
| **ParallelSweepEngine** | Zero tests. Worker spawning, concurrency limits, error isolation, scoring in parallel context all untested. |

### Missing test scenarios by package

**risk-manager** (6 untested branches):
- MAX_POSITION_SIZE rejection (quantity = 0, NaN, or Infinity)
- Constructor validation throws (7 paths, 0 tested)
- Cooldown exact boundary (`signal.timestamp - lastTradeClosedAt === cooldownAfterLossMs`)
- `expectedSlippageBps` non-zero quantity adjustment
- MAX_DAILY_LOSS kill switch clearing at day boundary (activate → cross day → verify cleared)
- MAX_DRAWDOWN kill switch persisting across day boundaries

**position-manager** (14 untested branches):
- SHORT position: SL exit via tick
- SHORT position: SL exit via candle
- SHORT position: TP exit via tick
- SHORT position: TP exit via candle
- SHORT position: trailing stop activation and breach
- SHORT position: timeout exit
- Tick-based TP exit (only tick-based SL is tested)
- Candle-based timeout exit (only tick-based timeout is tested)
- Candle-based trailing stop (only tick-based trailing stop is tested)
- `EXIT` signal handling (silently dropped — untested)
- `NO_ACTION` signal handling (silently dropped — untested)
- Config validation throws (6 paths, 0 tested)
- Exit order type verification (`STOP_MARKET` for SL, `TAKE_PROFIT_MARKET` for TP, `MARKET` for timeout)
- Risk REJECT severity: verify `risk:breach` is NOT emitted (only KILL is tested)

**indicators** (8 untested scenarios):
- Constructor validation (invalid period: 0, negative, non-integer) for all 5 indicators
- RSI with all-down candles (expected RSI = 0)
- RSI with flat prices (expected: debatable, currently returns 100)
- VWAP with zero volume (expected: null)
- ATR with varying true-range dominance (all fixture candles produce same TR = 80; `|high - prevClose|` and `|low - prevClose|` dominance branches never exercised)
- Post-seed Wilder smoothing numeric verification for RSI
- Post-seed Wilder smoothing numeric verification for ATR
- NaN/Infinity input handling for any indicator

**backtest-engine** (8 untested paths):
- Balance state after leveraged fills (would expose bug #1)
- Fee impact on final balance verification
- STOP_MARKET SELL not-triggered rejection
- TAKE_PROFIT_MARKET BUY not-triggered rejection
- TAKE_PROFIT_MARKET SELL not-triggered rejection
- LIMIT order with undefined price (rejection path)
- STOP_MARKET with undefined stopPrice (rejection path)
- TAKE_PROFIT_MARKET with undefined stopPrice (rejection path)

**data-feed** (6 untested paths):
- ReplayDataFeed gap detection / `validateCandleContinuity` error emission
- Deterministic replay verification (same data → same event order)
- LiveDataFeed dedup logic (duplicate closed candles)
- LiveDataFeed out-of-order candle handling
- Empty symbols/timeframes filter behavior in ReplayDataFeed
- ReplayDataFeed with invalid key format in candle map

**order-executor** (2 untested paths):
- BacktestExecutor `cancelAll()` (never called in tests)
- BacktestExecutor with non-FILLED/non-REJECTED statuses (e.g., PARTIALLY_FILLED)

**evolver** (5 untested paths):
- Stagnation counter triggering wider mutation rate
- Safety break in fill loop (`fillIdx > populationSize * 100`)
- `evolve()` error path (catch in `scheduleNextGeneration`)
- `buildInitialPopulation` with duplicate initial params
- Empty rankings from arena (would trigger crash — bug #11)

**sweep-engine** (4 untested paths):
- `maxCombinations` limit enforcement
- Custom scorer function
- Infinity handling in sort comparator
- NaN handling in sort comparator

**parity-checker** (1 untested):
- Pearson correlation calculation edge cases (identical values, negative correlation, single data point)

---

## P4 — Dependency & Configuration Issues

### Missing `package.json` dependencies

| Package | Missing dependency | Type | Notes |
|---------|-------------------|------|-------|
| `strategy` | `@trading-bot/exchange-client` | dependency | Imported in `src/types.ts` (production code) |
| `strategy` | `@trading-bot/order-executor` | dependency | Imported in `src/types.ts` (production code) |
| `position-manager` | `@trading-bot/test-utils` | devDependency | Used in test file |
| `order-executor` | `@trading-bot/test-utils` | devDependency | Used in test file |
| `risk-manager` | `@trading-bot/test-utils` | devDependency | Used in test file |

### Code quality

- `cartesianProduct` duplicated in `sweep-engine.ts` and `parallel-sweep-engine.ts` (#41).
- Magic number `86_400_000` (ms per day) repeated in `risk-manager.ts` and `vwap.ts`. Extract `const MS_PER_DAY`.
- `KahanSum.value` getter returns `this.sum` without applying final compensation correction (`this.sum + this.compensation`). The last iteration's rounding error remains uncorrected. Minor precision impact.
- `Candle` interface has no `symbol` field (unlike `Tick`, `OrderBookSnapshot`, `OrderBookDiff`).
- `Timeframe` union missing `'30m'` which is a common Binance-supported interval.
- `IExchange` has no subscribe method for user data streams despite `ExchangeStream` including `'userData'`.
- Mock exchange drops parameters on 7 methods (`getCandles`, `getOrderBook`, `cancelOrder`, `getOpenOrders`, `getPosition`, `setLeverage`, `getFees`). Structurally valid TypeScript but prevents multi-symbol testing.

---

## Summary

| Severity | Count | Key themes |
|----------|-------|------------|
| **P0 — Bugs** | 12 | Leverage deduction, reconnect-after-kill, intentionalDisconnect never reset, stale daily counters, stuck state machines, evolver crashes |
| **P1 — Security** | 6 | No rate limiting, unbounded memory, no request timeouts, race conditions |
| **P2 — Design** | 32 | Dead config/state, footgun configs, event bus re-entrancy, non-fatal errors, silent fallbacks |
| **P3 — Tests** | 5 critical zero-coverage areas + ~45 specific untested branches | LiveExecutor 0%, KahanSum 0%, WsConnection 0%, no SHORT exit tests, no backfill tests |
| **P4 — Deps/Config** | 5 missing deps + misc quality items | Phantom workspace dependencies, code duplication |

### Top 5 actions by impact

1. **Fix leverage balance deduction** (#1) — all leveraged backtests produce wrong final balances
2. **Fix `intentionalDisconnect` never-reset** (#3) — auto-reconnect permanently broken after first disconnect
3. **Add `checkAndResetDaily` to `checkEntry`** (#4) — stale daily risk checks across day boundaries
4. **Write LiveExecutor + exchange-client integration tests** (P3) — entire money boundary is untested
5. **Fix reconnect-after-kill** (#2) — live system trades on a "killed" connection
