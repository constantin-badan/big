# Improvement Checklist

Full audit conducted 2026-03-27. Items ordered by priority within each section.

---

## Critical — Fix Before Live Capital

- [ ] **Add WS request timeout** — `pendingRequests` map in `binance/adapter.ts:43-46,588` records `requestTime` but never enforces a deadline; hung requests leak memory and starve the queue. Auto-reject after N seconds, clean map on disconnect/reconnect.
- [ ] **Split `connected` into two flags** — single boolean in `adapter.ts:100` covers both trading WS and market-data WS. Market data down + trading up → `isConnected() === true` → strategies trade blind. Replace with `tradingConnected` + `marketDataConnected`; `isConnected()` = both true.
- [ ] **Fix arena event listener cleanup** — `removeInstance()` at `arena.ts:159` uses fire-and-forget `void`; if `destroyInstance()` throws, forwarders leak and instance is deleted from map anyway. Make async, handle errors, ensure forwarder disposal.
- [ ] **Guard against NaN/Infinity in risk sizing** — `risk-manager.ts:211-212` computes `quantity = balance * pct * leverage / entryPrice` with no check for `entryPrice === 0` or NaN. Add: `if (!Number.isFinite(quantity) || quantity <= 0) return { allowed: false, ... }`.
- [ ] **Add concurrent reconnection lock** — `reconnectTrading()` and `reconnectMarketData()` in `adapter.ts:353-478` can run concurrently with no mutex. If disconnect is called mid-reconnect, a race allows reconnection to continue despite intentional shutdown. Add per-stream lock or atomic flag.

---

## High — Address Before Extended Live Runs

- [ ] **Update `.gitignore`** — missing `.env*`, `*.pem`, `*.key`, `*.p8`, `*.db`, `*.sqlite`, `credentials*`, `secrets/`, `config.prod.*`. Add these patterns to prevent accidental secret/database commits.
- [ ] **Add runtime schema validation for Binance responses** — `unsafeCast<T>()` in `binance/unsafe-cast.ts` trusts API shape blindly. Add `zod` or similar validation for critical responses: order fills, account balance, position data. Silent shape changes from Binance could cause wrong trades.
- [ ] **Propagate backfill failures via existing events** — `live-data-feed.ts:61-66` fires-and-forgets gap backfill; errors logged at line 149 but strategies never notified. Emit `error` with `{ source: 'data-feed', ... }` for observability. If a failed backfill should halt trading, emit `risk:breach` with `severity: 'KILL'` — don't add a new event type to `TradingEventMap` for infrastructure failures; the bus is for trading domain events.
- [ ] **Wrap evolver loop in try-catch** — `evolver.ts:136-139` schedules `void this.evolve()` with no error boundary. If `evolve()` throws, the timer keeps firing. Catch errors, emit an event, and set `running = false` on unrecoverable failure.
- [ ] **Expand live-runner test coverage** — currently 1 test for 243 LOC of critical startup/shutdown/orphan-detection logic. Add tests for: orphan position detection, health check interval, `close-all` vs `leave-open` shutdown, duplicate `start()`/`stop()` calls.
- [ ] **Add timeout on `strategy.stop()` in arena** — `arena.ts:248` awaits `strategy.stop()` indefinitely. A hung strategy blocks entire arena shutdown. Use `Promise.race([strategy.stop(), timeout(5000)])`.
- [ ] **Truncate REST error messages** — `adapter.ts:606,627` includes full response body in thrown Error. If Binance returns a large response, this bloats error objects and logs. Truncate to first 500 chars.
- [ ] **Add cross-arena risk limits** — each arena instance has independent risk limits. 10 instances × `maxConcurrentPositions` = 10× intended total exposure. Even in paper-trade mode, this produces misleading metrics since each instance assumes exclusive capital access. Add a shared `ArenaRiskBudget` that tracks total exposure across instances and rejects entries when the global limit is hit.
- [ ] **Handle Binance maintenance windows** — Binance announces scheduled maintenance via status API and sometimes via a WS message before disconnecting. The adapter should detect these (status endpoint check on heartbeat, or recognizing the specific disconnect code) and emit `exchange:disconnected` with `reason: 'maintenance'` instead of entering reconnection loops that will fail for the entire window. Without this, every scheduled maintenance triggers 10 consecutive reconnect failures → KILL switch → manual restart.

---

## Medium — Improve Robustness
- [ ] **Add signal merge timeout** — `strategy.ts:50` calls user-provided merge function synchronously with no timeout. An infinite loop in merge hangs the entire bot. Wrap in a try-catch at minimum; consider a deadline.
- [ ] **Deduplicate stream callbacks** — `adapter.ts:640` pushes callbacks without dedup check; `indexOf` at line 654 removes only the first match. Use a Set instead of array, or check before push.
- [ ] **Unsubscribe logging handlers in live-runner** — `live-runner.ts:209-212` registers event handlers in `setupLogging()` but never unsubscribes in `stop()`. If runner is restarted, duplicate handlers accumulate. Store handler references and clean up.
- [ ] **Surface partial sweep failures** — `parallel-sweep-engine.ts:78-112` silently drops errors when some workers succeed. Return both results and errors, or at minimum emit a warning with failed parameter sets.
- [ ] **Validate rate limit config** — `live-executor.ts:55-57` computes `refillRate = rateLimitPerMinute / 60_000`. If config value is 0 or negative, `consumeToken()` sleeps forever. Add constructor validation: `if (rateLimitPerMinute <= 0) throw`.
- [ ] **Account for slippage in risk sizing** — `risk-manager.ts:211-212` sizes positions at exact `entryPrice`. Actual fill includes slippage, meaning real risk is slightly larger than calculated. Adjust by expected slippage bps.
- [ ] **Add backtest cleanup on partial failure** — `backtest-engine.ts:64-71` finally block cleans event handler and exchange, but if `strategy.start()` throws, strategy is never stopped. If `dataFeed.start()` throws, strategy is left running. Add per-component teardown.

---

## Deferred — Requires Architectural Discussion

- [ ] **Account-level unrealized drawdown protection** — risk-manager deliberately tracks realized balance only (ADR-7); intra-trade risk is position-manager's job via SL/TP. Adding mark-to-market unrealized PnL to risk-manager would require tick subscriptions for every open position, making it the most expensive component and duplicating position-manager's responsibility. If account-level unrealized drawdown protection is needed, design a separate `MarginGuard` component rather than modifying risk-manager. Contradicts ADR-7 — do not implement without explicit architectural decision.

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
