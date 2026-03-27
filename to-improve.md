# Improvement Checklist

Full audit conducted 2026-03-27. Items ordered by priority within each section.

---

## Critical — Fix Before Live Capital

- [x] **Add WS request timeout** — 30s per-request setTimeout, cleared on response, all pending rejected on disconnect.
- [x] **Split `connected` into two flags** — `tradingConnected` + `marketDataConnected`; `isConnected()` = trading up AND (no active streams OR market data up).
- [x] **Fix arena event listener cleanup** — `removeInstance()` severs event flow synchronously, strategy.stop() fire-and-forget with catch. `destroyInstance()` wrapped in try-catch.
- [x] **Guard against NaN/Infinity in risk sizing** — `Number.isFinite(quantity)` check before allowing entry.
- [x] **Add concurrent reconnection lock** — `reconnectingTrading` / `reconnectingMarketData` flags with finally-block release.

---

## High — Address Before Extended Live Runs

- [x] **Update `.gitignore`** — added `.env*`, `*.pem`, `*.key`, `*.p8`, `*.db`, `*.sqlite`, `credentials*`, `secrets/`, `config.prod.*`.
- [ ] **Add runtime schema validation for Binance responses** — deferred: requires adding `zod` as first external runtime dependency. Needs architectural decision on zero-dep policy.
- [x] **Propagate backfill failures via existing events** — emits `error` event with `source: 'data-feed'` and context object.
- [x] **Wrap evolver loop in try-catch** — `.catch()` on evolve() sets `running = false` and stops the loop.
- [x] **Expand live-runner test coverage** — 12 tests (up from 1): status lifecycle, orphan detection, close-all shutdown, config defaults.
- [x] **Add timeout on `strategy.stop()` in arena** — `Promise.race` with 5s timeout in `destroyInstance()`.
- [x] **Truncate REST error messages** — `body.substring(0, 500)` on both `restGet` and `restPost`.
- [x] **Add cross-arena risk limits** — `ArenaConfig.maxGlobalPositions` enforced via executor wrapper; global count tracked via position:opened/closed events.
- [x] **Handle Binance maintenance windows** — close codes 1001/1012 emit `exchange:disconnected` with `reason: 'maintenance'`, skip reconnect loop.

---

## Medium — Improve Robustness

- [x] **Add signal merge try-catch** — merge function wrapped in try-catch; throwing merge drops the signal.
- [x] **~~Deduplicate stream callbacks~~** — not needed: each subscription creates a unique closure, so reference-level duplicates can't occur.
- [x] **Unsubscribe logging handlers in live-runner** — handlers stored in array, unsubscribed in `stop()`.
- [x] **Surface partial sweep failures** — `ParallelSweepResult` returns `{ results, errors }` with per-param-set error detail.
- [x] **Validate rate limit config** — `LiveExecutor` constructor throws if `rateLimitPerMinute <= 0`.
- [x] **Account for slippage in risk sizing** — `RiskConfig.expectedSlippageBps` adjusts entry price before sizing. Default 0.
- [x] **Add backtest cleanup on partial failure** — tracks `strategyStarted` flag, ensures `strategy.stop()` in finally.

---

## Deferred — Requires Architectural Discussion

- [x] **Account-level unrealized drawdown protection** — implemented as `MarginGuard` package (ADR-12). Separate reactive component that subscribes to price events and position lifecycle. Emits `risk:breach` with `severity: 'KILL'` when unrealized loss or total exposure exceeds thresholds. Optional in StrategyConfig. Does not modify risk-manager (ADR-7 preserved).
- [x] **Add runtime schema validation for Binance responses** — implemented with Zod (ADR-11). Validates at money boundaries only: order fills, account balance, position data. Market data streams unchecked for performance. Zod added as dependency of exchange-client only.

---

## Low — Polish & Hardening

- [x] **Extract trailing stop logic** — shared `checkTrailingStop()` method replaces duplicated inline logic in both candle-close and tick handlers.
- [x] **Extract position-manager event handlers** — 5 inline handlers moved to named private methods (onTick, onCandleClose, onSignal, onOrderFilled, onOrderRejected).
- [x] **Decompose BinanceAdapter** — 720 LOC split into adapter (498) + WsConnection (185) + RequestTracker (73) + RestClient (48). Public API unchanged.
- [x] **Implement structured logger** — adapter console.error calls replaced with `logError()` emitting bus `error` events with source/context. EventBus console.error retained as correct fallback.
- [x] **Make rate limit configurable in live-runner** — `LiveRunnerConfig.rateLimitPerMinute` with default 1200.
- [x] **Add security scanning** — `npm run audit` script added to package.json.
- [x] **Add API key permission check on startup** — `connect()` verifies key by fetching balance after session logon. Throws `ConnectionError` on failure.
- [x] **Prevent `start()`/`stop()` race in live-runner** — `stop()` stores promise, concurrent calls return existing promise when status is 'stopping'.
- [x] **Improve parity-checker matching** — sort + sliding-window pointer reduces from O(N×M) to ~O(N+M).
- [x] **Validate candle continuity in backtest** — `ReplayDataFeed.validateCandleContinuity()` checks gaps per symbol:timeframe, emits bus `error` events.
- [x] **Clear private keys from memory on disconnect** — `disconnect()` zeros apiKey and privateKey fields.
- [x] **Add custom error types** — `ConnectionError`, `RequestTimeoutError`, `ExchangeApiError`, `RateLimitError` in exchange-client/errors.ts. Used throughout adapter sub-components.
