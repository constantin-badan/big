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

- [ ] **Account-level unrealized drawdown protection** — risk-manager deliberately tracks realized balance only (ADR-7); intra-trade risk is position-manager's job via SL/TP. Adding mark-to-market unrealized PnL to risk-manager would require tick subscriptions for every open position, making it the most expensive component and duplicating position-manager's responsibility. If account-level unrealized drawdown protection is needed, design a separate `MarginGuard` component rather than modifying risk-manager. Contradicts ADR-7 — do not implement without explicit architectural decision.
- [ ] **Add runtime schema validation for Binance responses** — requires adding `zod` as first external runtime dependency. Needs decision on zero-dep policy vs. silent shape change risk.

---

## Low — Polish & Hardening

- [ ] **Extract trailing stop logic** — `position-manager.ts` duplicates trailing stop activation/evaluation in candle-close handler (lines 119-127) and `evaluateSLTP` method (lines 314-322). Extract to `private evaluateTrailingStop()`.
- [ ] **Extract position-manager event handlers** — constructor is ~210 lines with 5 inline handler definitions. Extract to named private methods for readability.
- [ ] **Decompose BinanceAdapter** — 672 LOC handling WS management, REST calls, reconnection, request tracking, and fill dedup. Split into sub-components (e.g., `WsConnectionManager`, `RestClient`, `RequestTracker`).
- [ ] **Implement structured logger** — replace scattered `console.error`/`console.log` calls in `adapter.ts`, `live-runner.ts`, `live-data-feed.ts`, `event-bus.ts` with a logger abstraction supporting levels (DEBUG/INFO/WARN/ERROR) and sensitive data redaction.
- [ ] **Make rate limit configurable in live-runner** — hardcoded `1200` at `live-runner.ts:82`. Move to `LiveRunnerConfig` with a sensible default.
- [ ] **Add security scanning to CI** — no `npm audit`, `snyk`, or `dependabot` configured. Add to pre-commit or CI pipeline.
- [ ] **Add API key permission check on startup** — verify the configured API key has trading permissions before attempting orders. Fail fast with a clear error message.
- [ ] **Prevent `start()`/`stop()` race in live-runner** — no `stopping` state guard. Concurrent calls can create overlapping intervals or double-cleanup. Add lifecycle state machine (`idle → starting → running → stopping → stopped`).
- [ ] **Improve parity-checker matching** — greedy first-match at `parity-checker.ts:61-114` doesn't optimize global assignment. For large trade sets, consider Hungarian algorithm or at least sort-then-match.
- [ ] **Validate candle continuity in backtest** — `ReplayDataFeed` replays candles in time order but doesn't detect gaps. Silent gaps produce misleading backtest results. Emit a warning if expected candle timestamps are missing.
- [ ] **Clear private keys from memory on disconnect** — `adapter.ts:93-94` holds keys for adapter lifetime. Zero out key material in `disconnect()` to limit exposure window.
- [ ] **Add custom error types** — all errors are `new Error(string)`. Introduce typed errors (e.g., `RateLimitError`, `ConnectionError`, `ValidationError`) for programmatic handling in callers.
