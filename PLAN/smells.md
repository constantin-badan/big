# Full Deep Audit — Code Smells & Issues

## CRITICAL Issues (fix immediately)

### 1. `LiveExecutor.hasPending()` is broken
**`packages/order-executor/src/live-executor.ts:122-135`**
The nested loop tries to match in-flight orders (in `this.pending`) against queued items, but in-flight orders are NOT in the queue. The fallback `this.queue.some(...)` makes the first loop irrelevant. Result: **in-flight orders are never reported as pending**, so the system can submit duplicate orders for the same symbol.

### 2. MarginGuard position matching fails on duplicates
**`packages/margin-guard/src/margin-guard.ts:88-92`**
Matches positions by `(side, entryPrice, quantity)`. Two identical positions at the same entry price can't be distinguished — only the first is removed on close. Exposure and unrealized PnL drift permanently after this.

### 3. Fill deduplication drops partial fills
**`packages/exchange-client/src/binance/adapter.ts:403-405`**
Dedup key is `${orderId}:${status}`. Multiple `PARTIALLY_FILLED` events for the same order share the same key — **only the first partial fill is ever emitted**. All subsequent fills are silently dropped.

### 4. Backfill race condition in LiveDataFeed
**`packages/data-feed/src/live-data-feed.ts:60-72, 135-164`**
`backfillGap()` is fire-and-forget (`void this.backfillGap(...)`). A second gap event during an active backfill runs concurrently, potentially emitting duplicate candles. The `lastOpenTime` dedup map is updated mid-backfill, creating a TOCTOU race.

### 5. Backtest engine double-stops strategy
**`packages/backtest-engine/src/backtest-engine.ts:69 & 73`**
`strategy.stop()` is called on line 69 (normal flow) and again in the `finally` block on line 73. Undefined behavior if strategy expects single stop — could double-cleanup event handlers or leak resources.

### 6. Backtest sim exchange ignores SHORT margin
**`packages/backtest-engine/src/backtest-sim-exchange.ts:147`**
Margin check only applies when `request.side === 'BUY'`. SELL (short) orders are never rejected for insufficient margin. Backtests can open unlimited short positions on zero balance, producing unrealistic results.

### 7. Parallel sweep engine loses work on worker crash
**`packages/sweep-engine/src/parallel-sweep-engine.ts:100-117`**
When a worker crashes, `completed++` fires but `nextIndex` wasn't incremented for the failed job. The crashed combination is never retried — results are silently incomplete.

---

## HIGH Issues

### Architecture & Types
| Issue | Location |
|-------|----------|
| `OrderRequest` not discriminated by order type — `LIMIT` without `price` compiles fine | `types/src/index.ts:55-65` |
| `Signal.confidence` is unbounded `number` — allows 999.0 | `types/src/index.ts:112` |
| `KahanSum` class (runtime code) lives in `types` package | `types/src/index.ts:298-320` |
| `SlippageModel` allows silent defaults (fixedBps missing -> silently defaults to 2) | `types/src/index.ts:349-354` |
| `PositionManagerConfig.defaultTakeProfitPct` is never validated | `position-manager/src/position-manager.ts` (missing) |
| `RiskConfig.cooldownAfterLossMs` can be negative — no validation | `risk-manager/src/risk-manager.ts` (missing) |
| `strategy/package.json` missing declared deps on `exchange-client` and `order-executor` | `strategy/package.json:11-17` |

### Core Trading Logic
| Issue | Location |
|-------|----------|
| SL/TP evaluation differs between candle-close and tick paths (different tiebreak semantics) | `position-manager/src/position-manager.ts:165-178 vs 375-389` |
| Trailing stop divides by `peakPrice` with no `isFinite` guard | `position-manager/src/position-manager.ts:313-314` |
| Pending set tracks `clientOrderId` only, not `(clientOrderId, symbol)` pairs | `order-executor/src/live-executor.ts:36` |
| Items lost forever if `stop()` called during retry | `order-executor/src/live-executor.ts:192-195` |
| `trade.exitTime` not validated before daily-reset math — NaN causes reset to never fire | `risk-manager/src/risk-manager.ts:85` |
| MarginGuard emits `rule: 'MAX_DRAWDOWN'` for all breach types | `margin-guard/src/margin-guard.ts:137` |

### Infrastructure
| Issue | Location |
|-------|----------|
| Event bus: slow/blocking handler stalls all subsequent handlers (sync loop) | `event-bus/src/event-bus.ts:42-49` |
| Order placement WS ack != order confirmation — order can be rejected async | `exchange-client/src/binance/adapter.ts:216-222` |
| No WebSocket backpressure in LiveDataFeed — fast feed + slow handler = memory leak | `data-feed/src/live-data-feed.ts:47-57` |
| No exchange rate limiting implemented anywhere | `exchange-client/src/binance/` (absent) |
| Multiple concurrent WS connections possible due to un-awaited connect | `exchange-client/src/binance/adapter.ts:465-468` |

### Orchestration
| Issue | Location |
|-------|----------|
| Live runner shutdown: `cancelAll()` not awaited before draining executor | `live-runner/src/live-runner.ts:179-184` |
| Sharpe ratio annualized to finest timeframe, not evaluation period — inflates wildly | `reporting/src/metrics.ts:160-162` |
| Arena `strategy.start()` is fire-and-forget — failures silently swallowed | `arena/src/arena.ts:251` |
| Arena global position counter is non-atomic under async execution | `arena/src/arena.ts:220-227` |

---

## MEDIUM Issues

### Code & Logic
- **Strategy `signalMerge` errors silently dropped** — no logging/event (`strategy/src/strategy.ts:51-55`)
- **Token bucket rate limiter jittery** with negative tokens (`order-executor/src/live-executor.ts:219`)
- **SMA floating-point drift** — running sum accumulates error over thousands of candles (`indicators/src/sma.ts:26-34`)
- **RSI returns 100 when avgGain=0 AND avgLoss=0** — should return 50 (`indicators/src/rsi.ts:73-75`)
- **VWAP session reset assumes UTC midnight** — wrong for non-24h markets (`indicators/src/vwap.ts:24`)
- **Backtest loads all candles into memory upfront** — GBs for multi-year/multi-symbol runs (`backtest-engine/src/backtest-engine.ts:39-48`)
- **No stale data detection in LiveDataFeed** — WS lag invisible to users
- **No crash recovery in live-runner** — no persistent state snapshot
- **Evolver elite reset via remove/add loses trade history** (`evolver/src/evolver.ts:209-211`)
- **Parity checker tolerance hardcoded** to finest timeframe (`parity-checker/src/parity-checker.ts:176`)
- **Error events use non-serializable `Error` objects** (`event-bus/src/types.ts:60`)

### Configuration & Safety
- No branded types for `Symbol`, `OrderId`, `Price`, `Quantity` — easy to swap by accident
- `BacktestConfig` allows empty `symbols[]`, `startTime > endTime` — no validation
- `ExchangeConfig.defaultLeverage` optional with no documented default
- Live-runner has unused `@trading-bot/storage` dependency (`live-runner/package.json:16`)
- `margin-guard` missing `reset.d.ts` (19/20 packages have it)

---

## Testing Gaps

| Dimension | Score | Notes |
|-----------|-------|-------|
| Package coverage | **A** (21/21) | Every package has tests |
| Financial precision | **B+** | Kahan tested, but no rounding/extreme-value edge cases |
| Edge cases | **C+** | NaN, Infinity, zero balances, negative prices untested |
| Integration | **B-** | Backtest E2E exists; no cross-package flow tests |
| Live trading | **D** | Completely over-mocked |
| Property-based/fuzz | **F** | Absent |
| Concurrent scenarios | **C** | Sequential only; no simultaneous SL/TP, no multi-position races |

Key missing tests:
- Golden reference backtests against known-correct trade lists
- SHORT position lifecycle
- Multi-day backtests with daily reset boundary
- Indicator behavior on NaN/Infinity input
- Worker crash recovery in parallel sweep

---

## Architecture Assessment

**What's done well:**
- Clean DAG — zero circular dependencies across 20 packages
- 8 distinct layers (types -> infra -> domain -> orchestration -> meta)
- `@nx/enforce-module-boundaries` configured and passing
- 100% consistent scripts, tsconfigs, and project.json across all packages
- Strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- `oxlint` denies `any`, all unsafe patterns, and floating promises
- Good domain separation — single-responsibility packages throughout

---

## Top 10 Recommended Fixes (priority order)

1. **Fix `LiveExecutor.hasPending()`** — redesign to track `Map<clientOrderId, symbol>` for pending set
2. **Fix fill dedup key** — include fill quantity or transaction ID, not just status
3. **Fix MarginGuard position matching** — add unique ID to positions
4. **Discriminate `OrderRequest` by order type** — make `price` required for LIMIT, `stopPrice` for STOP
5. **Add margin check for SHORT orders** in backtest sim exchange
6. **Fix backtest engine double-stop** — remove explicit stop, rely on finally block only
7. **Await `backfillGap()`** or add a mutex to prevent concurrent backfills
8. **Fix parallel sweep worker crash handling** — increment `nextIndex` before spawning worker
9. **Fix Sharpe ratio annualization** — use actual evaluation period, not finest timeframe
10. **Add exchange rate limiting** — token bucket in exchange-client before any API call
