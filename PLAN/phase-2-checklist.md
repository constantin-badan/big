# Phase 2 — Core Implementation Checklist

Implement the stub packages in dependency order. All interfaces, types, and architectural rules are defined in the Phase 1 docs — this phase is building against those contracts.

**Reference docs:** [architecture.md](./architecture.md) · [types.md](./types.md) · [interfaces.md](./interfaces.md) · [tooling.md](./tooling.md)

**Rules that apply to every package:**

- Zero `as` casts — `assertionStyle: "never"` enforced by ESLint
- Zero lint disables anywhere in the codebase
- All tests use `@trading-bot/test-utils` (createTestBus, EventCapture, fixtures, mocks)
- Constructor-injected reactivity (ADR-8) — no `onX` callbacks
- State-before-emit rule (ADR-2) — update internal state before any emit or submit() call
- `dispose()` on all reactive components — unsubscribes from event bus

---

## 1. `indicators` — EMA, SMA, RSI, ATR, VWAP

**Implements:** `IIndicator<TConfig, TOutput>`, `IndicatorFactory`

**Indicators to build:**

| Indicator | Config                       | Output   | Warmup       | Notes                                                                                                              |
| --------- | ---------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| SMA       | `{ period: number }`         | `number` | `period`     | Simplest — good first test of IIndicator                                                                           |
| EMA       | `{ period: number }`         | `number` | `period`     | Multiplier: `2 / (period + 1)`. Seed first value with SMA or first close                                           |
| RSI       | `{ period: number }`         | `number` | `period + 1` | Wilder's smoothing (1/period). Output 0-100                                                                        |
| ATR       | `{ period: number }`         | `number` | `period`     | Raw price difference (not percentage — scanner divides by close if needed)                                         |
| VWAP      | `{ resetOffsetMs?: number }` | `number` | `1`          | UTC midnight reset by default. Detect boundary via `Math.floor((openTime - offset) / 86_400_000)`. No Date objects |

**Each indicator must:**

- [ ] Implement `IIndicator<TConfig, TOutput>` with `readonly name`, `readonly warmupPeriod`, `readonly config`
- [ ] Return `null` from `update()` during warmup period
- [ ] Be stateful — each `update(candle)` advances internal state
- [ ] `reset()` clears all internal state back to construction-time defaults
- [ ] Export a factory: `const createEMA: IndicatorFactory<EMAConfig> = (config) => new EMA(config)`

**Tests (per indicator):**

- [ ] Warmup: first N calls return `null`, N+1 returns a value
- [ ] Known values: compare against a reference implementation (TradingView, pandas-ta) for a fixture candle series
- [ ] Reset: after processing candles, `reset()` + same candles = same output
- [ ] Factory creates independent instances (no shared state between factory calls)

---

## 2. `risk-manager` — Reactive state machine

**Implements:** `IRiskManager` (ADR-7, ADR-8)

**Constructor:** `(eventBus: IEventBus, config: RiskConfig)`

**Internal state (built from events):**

- `balance: number` — starts at `config.initialBalance`, updated via `position:closed` → `+= trade.pnl` (use KahanSum)
- `peakBalance: number` — high-water mark of `balance` (for drawdown)
- `openPositionCount: number` — incremented on `position:opened`, decremented on `position:closed`
- `dailyTradeCount: number` — incremented on `order:filled`, resets at UTC midnight
- `dailyPnl: number` — accumulated from `position:closed` trades within current day
- `lastTradeTimestamp: number | null` — from last `order:filled`
- `lastTradePnl: number` — from last `position:closed` trade (for cooldown-after-loss)

**Event subscriptions:**

- [ ] `position:opened` → increment `openPositionCount`
- [ ] `position:closed` → decrement `openPositionCount`, update `balance`, `peakBalance`, `dailyPnl`, `lastTradePnl`
- [ ] `order:filled` → increment `dailyTradeCount`, update `lastTradeTimestamp`

**`checkEntry(signal, entryPrice)` checks (in order):**

- [ ] Kill switch active → `{ allowed: false, rule: 'MAX_DAILY_LOSS', severity: 'KILL' }` or `MAX_DRAWDOWN`
- [ ] `MAX_CONCURRENT` — `openPositionCount >= config.maxConcurrentPositions`
- [ ] `MAX_DAILY_TRADES` — `dailyTradeCount >= config.maxDailyTrades`
- [ ] `COOLDOWN` — `lastTradePnl < 0 && now - lastTradeTimestamp < config.cooldownAfterLossMs`
- [ ] `MAX_DAILY_LOSS` — `dailyPnl <= -(config.initialBalance * config.maxDailyLossPct)` → severity: `KILL`
- [ ] `MAX_DRAWDOWN` — `(peakBalance - balance) / peakBalance >= config.maxDrawdownPct` → severity: `KILL`
- [ ] `MAX_POSITION_SIZE` — compute `quantity = (balance * config.maxPositionSizePct * config.leverage) / entryPrice`; if quantity ≤ 0, reject
- [ ] All pass → `{ allowed: true, quantity }`

**Tests:**

- [ ] Fresh state + valid signal → `allowed: true` with correct quantity
- [ ] Max concurrent hit → `REJECT`
- [ ] Max daily trades hit → `REJECT`
- [ ] Cooldown after loss → `REJECT`
- [ ] Max daily loss → `KILL` + `isKillSwitchActive() === true`
- [ ] Max drawdown → `KILL`
- [ ] Balance tracking across multiple position:closed events (use KahanSum)
- [ ] Daily counters reset at UTC midnight boundary
- [ ] `reset()` restores initial state
- [ ] `dispose()` unsubscribes (emit after dispose → no state change)

---

## 3. `order-executor` — Async queue with sync submit()

**Implements:** `IOrderExecutor` (ADR-2)

**Two implementations needed (both in this package):**

### BacktestExecutor

- Constructor: `(eventBus: IEventBus, fillSimulator: IFillSimulator)`
- `submit()` calls `fillSimulator.simulateFill(request)` synchronously
- Emits `order:submitted` then `order:filled` (or `order:rejected`) synchronously within the same call
- `start()` / `stop()` are no-ops
- `hasPending()` always returns `false` (fills are instant)

### LiveExecutor (stub for Phase 2)

- Constructor: `(eventBus: IEventBus, exchange: IExchange)`
- `submit()` enqueues request, emits `order:submitted`, returns receipt
- Internal async queue calls `exchange.placeOrder()`, emits `order:filled` / `order:rejected` on completion
- `start()` starts the queue, `stop()` drains and stops
- Implement with retry logic (`config.maxRetries`, `config.retryDelayMs`)
- Rate limiting (`config.rateLimitPerMinute`)

### IFillSimulator (backtest seam)

```typescript
export interface IFillSimulator {
  simulateFill(request: OrderRequest): OrderResult; // sync
}
```

Implemented by BacktestSimExchange (see backtest-engine below).

**Tests:**

- [ ] BacktestExecutor: `submit()` emits `order:filled` synchronously (capture events, assert count === 1 after submit returns)
- [ ] BacktestExecutor: `hasPending()` always false
- [ ] SubmissionReceipt has correct fields
- [ ] `order:submitted` event fires before `order:filled`

---

## 4. `position-manager` — State machine

**Implements:** `IPositionManager` (ADR-2, ADR-8)

**Constructor:** `(eventBus: IEventBus, executor: IOrderExecutor, riskManager: IRiskManager, config: PositionManagerConfig)`

**Per-symbol state machine:** `Map<string, PositionState>`

- `IDLE` → `PENDING_ENTRY` → `OPEN` → `PENDING_EXIT` → `IDLE`

**Internal tracking:**

- `lastTickPrice: Map<string, number>` — updated on every `tick`
- `pendingOrders: Map<string, SubmissionReceipt>` — tracks in-flight orders
- `openTrades: Map<string, { entryOrder: OrderResult, peakPrice: number, ... }>` — for TradeRecord assembly

**Event subscriptions:**

- [ ] `tick` → update `lastTickPrice[symbol]`; if state is `OPEN`, evaluate SL/TP/trailing against tick price
- [ ] `candle:close` → if state is `OPEN`, evaluate SL/TP against `candle.high` / `candle.low` (backtest path). SL-wins tiebreak if both hit
- [ ] `signal` → if state is `IDLE`, call `riskManager.checkEntry(signal, lastTickPrice ?? signal.price)`. If allowed, set state `PENDING_ENTRY`, call `executor.submit()` with `result.quantity`
- [ ] `order:filled` → if `PENDING_ENTRY`, transition to `OPEN`, record entry fill. If `PENDING_EXIT`, transition to `IDLE`, build `TradeRecord`, emit `position:closed`
- [ ] `order:rejected` → if `PENDING_ENTRY`, transition to `IDLE`. If `PENDING_EXIT`, transition back to `OPEN`

**State-before-emit rule:** Always set state BEFORE calling `submit()` or emitting events.

**TradeRecord assembly on exit fill:**

- `entryPrice` from stored entry `OrderResult.avgPrice`
- `exitPrice` from exit `OrderResult.avgPrice`
- `slippage` = `|avgPrice - requestedPrice|`
- `fees` = entry commission + exit commission
- `pnl` = `(exitPrice - entryPrice) * quantity * direction` - fees (where direction = 1 for LONG, -1 for SHORT)
- `exitReason` from whichever condition triggered the exit

**Tests:**

- [ ] Full entry flow: signal → checkEntry → submit → order:filled → state is OPEN
- [ ] Full exit flow: SL hit on tick → submit exit → order:filled → state is IDLE, position:closed emitted with TradeRecord
- [ ] SL hit on candle:close (backtest path) — check against candle.low (long) / candle.high (short)
- [ ] SL + TP both hit in same candle → SL wins
- [ ] Trailing stop: peak price tracks, exit when price drops by trailingStopDistancePct from peak
- [ ] Duplicate signal while PENDING_ENTRY → ignored (state check)
- [ ] Order rejected while PENDING_ENTRY → back to IDLE
- [ ] Timeout exit: `config.maxHoldTimeMs` exceeded
- [ ] `dispose()` unsubscribes

---

## 5. `data-feed` — Backtest replay variant

**Implements:** `IDataFeed`

**Phase 2 only builds `ReplayDataFeed`** — live WebSocket data-feed is Phase 3.

**Constructor:** `(eventBus: IEventBus, candles: Map<string, Candle[]>)`

- Keyed by `${symbol}:${timeframe}`
- Candles are pre-loaded by the backtest-engine via `CandleLoader`

**Replay logic:**

- `start()` iterates all candle arrays merged and sorted by `openTime`
- For each candle: emits `candle:close` on the bus with `{ symbol, timeframe, candle }`
- Multi-timeframe: interleaves candles from different timeframes in chronological order
- Emits `candle:close` only — never `candle:update` (historical candles are closed by definition)

**`getOrderBook()`** returns `null` in backtest mode.

**No gap backfill logic needed** — replay has no gaps. The async backfill queue is a live-feed concern (Phase 3).

**Tests:**

- [ ] Replays candles in chronological order
- [ ] Multi-timeframe interleaving: 1m and 4h candles arrive in correct time order
- [ ] EventCapture records correct `candle:close` events with right payloads
- [ ] `stop()` halts replay
- [ ] `getOrderBook()` returns `null`

---

## 6. `scanner` — Base implementation

**Implements:** `IScanner`, `ScannerFactory` (ADR-6, ADR-8, ADR-9)

**Constructor:** `(eventBus: IEventBus, config: IScannerConfig)`

- Creates indicator instances per symbol: `Map<symbol, Map<indicatorName, IIndicator>>`
- Calls each `IndicatorFactory` in `config.indicators` once per symbol
- Subscribes to `candle:close` filtered by `config.timeframe`

**On `candle:close`:**

1. Look up (or lazily create) indicator map for this symbol
2. Call `update(candle)` on each indicator
3. If any indicator returns `null` (warmup) → skip
4. Run signal logic (subclass/implementation-specific)
5. If signal → emit `scanner:signal` on bus with `{ signal }` where `signal.price = candle.close`

**Phase 2 delivers a base `Scanner` class** that subclasses extend with custom signal logic, plus one concrete scanner (e.g., EMA crossover) for integration testing.

**Tests:**

- [ ] Scanner subscribes to correct timeframe only (emit 1m and 5m candles, scanner on 1m ignores 5m)
- [ ] Indicators warm up — no `scanner:signal` during warmup period
- [ ] After warmup, signal is emitted with correct `sourceScanner`, `price`, `timestamp`
- [ ] Per-symbol indicator isolation: BTCUSDT indicators don't see ETHUSDT candles
- [ ] `dispose()` unsubscribes — candle:close after dispose produces no signals
- [ ] Factory creates independent scanner instances

---

## 7. `strategy` — Signal merge + lifecycle

**Implements:** `IStrategy`, `StrategyFactory`, `StrategyDeps`, `SignalMerge`, `SignalBuffer` (ADR-8, ADR-9, ADR-10)

**Constructor:** receives `StrategyConfig` + `StrategyDeps` (bus is in deps, components are in config)

**Signal merge flow:**

1. Subscribes to `scanner:signal` on the bus
2. On each `scanner:signal`: adds to `SignalBuffer` (keyed by `signal.sourceScanner`), prunes entries older than `config.signalBufferWindowMs`
3. Calls `config.signalMerge(trigger, buffer)`
4. If merge returns non-null → emits `signal` on the bus

**`start()`:** starts data-feed and executor if applicable (or no-op if already running)
**`stop()`:** calls `dispose()` on all components (scanners, position-manager, risk-manager), unsubscribes self
**`getStats()`:** returns stub zeros in Phase 2 (live-only concern, Phase 3)

**Phase 2 delivers:**

- The `Strategy` class implementing the merge/buffer/lifecycle
- A `passthroughMerge: SignalMerge` for single-scanner strategies: `(trigger) => trigger`

**Tests:**

- [ ] Single scanner: `scanner:signal` → `passthroughMerge` → `signal` emitted
- [ ] Multi-scanner: only emits `signal` when merge logic agrees (test with a custom merge)
- [ ] Buffer window: old signals pruned, merge sees only recent ones
- [ ] `stop()` calls `dispose()` on all components
- [ ] `getStats()` returns zeroed `PerformanceMetrics`

---

## 8. `backtest-engine` — Event-driven replayer

**Implements:** `IBacktestEngine`, `createBacktestEngine`, `CandleLoader` type (ADR-10)

**Also contains (internal implementations, not exported interfaces):**

- `BacktestSimExchange` — implements `IExchange` + `IFillSimulator`
- Uses `ReplayDataFeed` from data-feed package

**`createBacktestEngine(loader, exchangeConfig)` → `IBacktestEngine`**

**`run(factory, params, config)` flow:**

1. Create `bus = new EventBus()`
2. Create `exchange = new BacktestSimExchange(bus, exchangeConfig)` — implements both `IExchange` and `IFillSimulator`
3. Create `executor = new BacktestExecutor(bus, exchange)` — from order-executor package
4. For each `symbol × timeframe` in config: call `loader(symbol, tf, startTime, endTime)`
5. Create `dataFeed = new ReplayDataFeed(bus, loadedCandles)`
6. Subscribe to `position:closed` on bus → collect `TradeRecord[]`
7. Call `factory(params, { bus, exchange, executor })` → strategy
8. `await strategy.start()`
9. `await dataFeed.start(config.symbols, config.timeframes)` — pumps all candles
10. `await strategy.stop()`
11. Call `computeMetrics(trades, config.timeframes, exchangeConfig.initialBalance, startTime, endTime)` from reporting
12. Return `BacktestResult`

**BacktestSimExchange:**

- `simulateFill(request)`: sync fill based on order type
  - MARKET: `currentPrice ± slippage`
  - LIMIT: `order.price` if `currentPrice` crossed it, else reject
  - STOP_MARKET: `stopPrice ± slippage` if `currentPrice` crossed it
  - TAKE_PROFIT_MARKET: `stopPrice ± slippage` if `currentPrice` crossed it
- Slippage: fixed bps only (`config.slippageModel.fixedBps`). Throw for `proportional` or `orderbook-based`
- Fee: `quantity * price * feeStructure.taker` (assume taker for Phase 2)
- Tracks current price by subscribing to `candle:close` on the bus
- `getCandles()`: returns empty (no historical data access needed during replay)
- `getOrderBook()`: returns `null`
- `getBalance()`: returns virtual balance
- `subscribeCandles()` / `subscribeTicks()` / `subscribeOrderBookDiff()`: not used by replay data-feed

**Tests:**

- [ ] Full end-to-end: load fixture candles → create EMA crossover strategy → run → get BacktestResult with trades
- [ ] Fill simulation: MARKET fills at current price ± slippage
- [ ] Fill simulation: LIMIT fills at order price when price crosses
- [ ] Fill simulation: STOP_MARKET/TAKE_PROFIT_MARKET trigger correctly
- [ ] Fees deducted from each fill
- [ ] BacktestResult.metrics are computed (non-zero Sharpe, win rate, etc)
- [ ] `BacktestResult.trades` matches position:closed events collected during run

---

## 9. `reporting` — Performance metrics

**Implements:** `computeMetrics` (KahanSum already exists from Phase 1)

**`computeMetrics(trades, timeframes, initialBalance, startTime, endTime)`:**

All accumulations use `KahanSum`.

- [ ] `totalTrades` = `trades.length`
- [ ] `winRate` = wins / totalTrades (win = `trade.pnl > 0`)
- [ ] `profitFactor` = gross profit / gross loss (handle zero loss → Infinity)
- [ ] `avgWin` = mean PnL of winning trades
- [ ] `avgLoss` = mean PnL of losing trades
- [ ] `expectancy` = `(winRate * avgWin) + ((1 - winRate) * avgLoss)`
- [ ] `avgHoldTime` = mean `trade.holdTimeMs`
- [ ] `totalFees` = sum `trade.fees`
- [ ] `totalSlippage` = sum `trade.slippage`
- [ ] `maxDrawdown` = peak-to-trough percentage on the realized equity curve
- [ ] `maxDrawdownDuration` = longest time between equity peaks (ms)
- [ ] `sharpeRatio`:
  - Build equity curve: periodic returns at the finest timeframe interval
  - Risk-free rate: 0%
  - Annualization factor: `√(periodsPerYear)` where periodsPerYear derived from finest timeframe in `timeframes`
  - `sharpe = mean(returns) / stddev(returns) * annualizationFactor`
  - Handle zero stddev → 0

**Tests:**

- [ ] Known trade set → verify each metric against hand-calculated values
- [ ] Zero trades → all metrics are 0 (no division by zero)
- [ ] All winning trades → profitFactor = Infinity, winRate = 1
- [ ] All losing trades → profitFactor = 0, winRate = 0
- [ ] Sharpe with flat returns → 0
- [ ] Drawdown calculation: equity curve [100, 110, 90, 95, 120] → maxDrawdown = (110-90)/110 = 18.18%

---

## 10. `sweep-engine` — Cartesian product runner

**Implements:** `ISweepEngine`, `createSweepEngine`

**`createSweepEngine(engine: IBacktestEngine)` → `ISweepEngine`**

**`run(factory, grid, config)` flow:**

1. Compute cartesian product of `grid` → `Record<string, number>[]`
2. Sequential loop (Phase 2 — parallelism is Phase 3):
   - For each param combination: call `engine.run(factory, params, config)`
   - Collect `SweepResult { params, result }`
3. Sort results by `result.metrics.profitFactor` descending (or configurable)
4. Return sorted `SweepResult[]`

**Tests:**

- [ ] Grid `{ a: [1, 2], b: [3, 4] }` → 4 runs with params `{a:1,b:3}`, `{a:1,b:4}`, `{a:2,b:3}`, `{a:2,b:4}`
- [ ] Results are sorted by profit factor
- [ ] Empty grid → empty results
- [ ] Single-value grid → single run

---

## Integration test (after all packages)

- [ ] End-to-end: CandleLoader with fixture data → EMA crossover StrategyFactory → BacktestEngine.run() → BacktestResult with realistic metrics
- [ ] Sweep: 3-param grid × 3 values = 27 runs → sorted results, best params at top
- [ ] Verify no `as` casts anywhere: `grep -r " as " packages/*/src/ --include="*.ts" | grep -v __tests__ | grep -v "as const"` returns zero matches
- [ ] `npx nx run-many -t typecheck` — zero errors
- [ ] `npx nx run-many -t test` — all pass
- [ ] `npx nx run-many -t lint` — zero warnings
- [ ] `npx nx lint:boundaries` — zero violations
