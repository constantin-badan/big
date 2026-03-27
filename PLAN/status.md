# Project Status

Last updated: 2026-03-27

---

## Overview

Crypto trading bot platform for Binance USDⓈ-M Futures. Monorepo with 19 packages, ~17,700 lines of TypeScript, 278 tests passing. Built on Bun, Nx, oxlint, tsgo.

---

## What's Done

### Phase 1 — Foundation Scaffold

All core types, interfaces, and infrastructure.

| Package | Tests | Description |
|---------|-------|-------------|
| **types** | 3 | Domain types, KahanSum, ExchangeConfig discriminated union |
| **event-bus** | 11 | Synchronous typed EventBus (ADR-2) |
| **test-utils** | 11 | EventCapture, MockExchange, MockExecutor, fixtures |

### Phase 2 — Backtest Pipeline

Full backtest + sweep pipeline. All reactive components follow ADR-8 (constructor-injected).

| Package | Tests | Description |
|---------|-------|-------------|
| **indicators** | 29 | EMA, SMA, RSI, ATR, VWAP — factory pattern (ADR-6) |
| **scanner** | 9 | Single-timeframe signal generation, indicator evaluation |
| **risk-manager** | 15 | Reactive risk checks, kill switch, balance tracking from events |
| **position-manager** | 20 | Entry/exit state machine (IDLE→PENDING→OPEN→PENDING→IDLE), SL/TP/trailing |
| **order-executor** | 11 | BacktestExecutor (sync fills) + LiveExecutor (async queue) |
| **data-feed** | 14 | ReplayDataFeed (sync replay) + LiveDataFeed (WS semantic routing) |
| **strategy** | 9 | Signal merge, two-tier routing (ADR-9), lifecycle |
| **reporting** | 17 | KahanSum, computeMetrics (Sharpe, profit factor, drawdown, etc.) |
| **backtest-engine** | 23 | Event-driven replayer, BacktestSimExchange, full pipeline orchestration |
| **sweep-engine** | 6 | Sequential param grid sweep + parallel Bun worker variant |

### Phase 3 — Live Trading & Evolution

Live Binance integration and evolutionary optimization.

| Package | Tests | Description |
|---------|-------|-------------|
| **exchange-client** | 25 | BinanceAdapter: combined stream WS, trading WS API (ws-fapi), Ed25519 signing, algo service routing, reconnection with exponential backoff, gap detection |
| **data-feed** | (incl. above) | LiveDataFeed: isClosed filtering, tick forwarding, gap backfill with buffering and dedup |
| **order-executor** | (incl. above) | LiveExecutor: token bucket rate limiter (burst 60, refill 20/sec), priority cancel queue, reactive pending tracking, transport retry with exponential backoff |
| **live-runner** | 1 | LiveRunner: environment orchestration, structured JSON logging, 30s heartbeat with staleness detection, close-all/leave-open shutdown, orphan position detection |
| **storage** | 24 | SQLite candle + trade persistence via bun:sqlite, WAL mode, gap detection, dedup |
| **arena** | 11 | Parallel strategy tournament: shared exchange → broadcast to N isolated buses, paper-trade SimExecutor per instance |
| **evolver** | 29 | Evolutionary parameter selection: proportional mutation with ParamSpec bounds/step, Box-Muller gaussian, stagnation detector, elite survival |
| **parity-checker** | 10 | Backtest vs live trade comparison: fuzzy matching, per-field diffs in bps, backtestOverestimatesPnl calibration flag |
| **sweep-engine** | (incl. above) | createParallelSweepEngine: Bun workers, module-path API, built-in scorer enum |

### Architecture (10 ADRs)

1. **Float64 precision** — KahanSum for accumulated values
2. **Synchronous event bus** — deterministic backtesting, async via submit() pattern
3. **Connection lifecycle events** — exchange:connected/disconnected/reconnecting/gap
4. **Discriminated union ExchangeConfig** — compiler-enforced variant selection
5. **Raw streams in IExchange, semantics in data-feed** — abstraction boundary
6. **Factory pattern for indicators** — no clone(), fresh instances per run
7. **Reactive risk manager** — structured RiskCheckResult, built from events
8. **Constructor-injected reactive components** — subscribe in constructor, dispose() cleanup
9. **Two-tier signal routing** — scanner:signal → strategy merge → signal (actionable)
10. **Runner owns environment** — bus, exchange, executor injected via StrategyDeps

### Tooling

- **Pre-commit hooks**: lint (oxlint) → typecheck (tsgo) → test → boundary checks
- **Zero `as` assertions** — enforced by lint, `unsafeCast()` helper for trust boundaries
- **Nx module boundaries** — enforced dependency graph across all 19 packages

---

## What's Remaining

### 3a-hardened — Safety Stop (deferred to pre-production)

Exchange-side `STOP_MARKET` at 2× SL distance as crash safety net. Requires position-manager to:
- Place a safety stop on the exchange when entering a position
- Cancel it on normal exit
- Let it trigger only if the bot is dead

This is a position-manager refactoring task — the config fields (`safetyStopEnabled`, `safetyStopMultiplier`) already exist in `PositionManagerConfig`.

### 3a-hardened — 24h Hot-Swap Rotation (deferred)

Zero-gap WebSocket rotation every 24h:
- Open second market data connection
- Verify messages flowing on new connection
- Swap dispatch map
- Close old connection
- Emit exchange:gap only if there's actually a gap

Currently the adapter reconnects on disconnect (which handles Binance's 24h forced close), but with a brief gap. The hot-swap pattern eliminates the gap entirely. Not critical — the gap backfill mechanism handles any missed candles.

### 3c — Advanced Slippage Models (deferred)

Explicitly deferred until parity-checker data calibrates the fixed-bps model:

- **Orderbook-based slippage**: Walk the book to estimate fill price. Requires order book recovery hardening (full buffer-and-sequence-validate procedure in LiveDataFeed).
- **Proportional slippage**: `slippageBps = baseBps * (quantity / averageVolume)`
- **Calibration loop**: parity-check → adjust slippage → re-sweep → deploy

### 3g — Observability (deferred)

Quality of life, not on critical path:

- **CLI dashboard**: Rich TUI — open positions, PnL, signal buffer, risk state, connection status per stream
- **Alerting**: Kill switch → Telegram/Discord. Connection down > N min → alert. Drawdown approaching threshold → warning.
- **Metrics aggregation**: Prometheus/StatsD if needed

### Response-Based Rate Limit Sync (minor)

Token bucket adjustment against Binance's reported `count` in WS API responses. Currently the token bucket runs independently — works fine but can drift from Binance's actual counter if other clients share the API key.

---

## Next Steps (recommended order)

1. **Testnet validation** — Run a real strategy on Binance testnet via LiveRunner to validate the full end-to-end data flow (exchange → data-feed → scanner → strategy → position-manager → executor → exchange)
2. **Safety stop** — Add exchange-side crash net before going to production
3. **Parity-checker calibration** — After accumulating live trades, run parity checks to calibrate the slippage model
4. **24h hot-swap** — Implement when running strategies that must not miss any candles
5. **CLI dashboard** — When actively monitoring live strategies

---

## Commit History

```
bc4bdc6 Phase 3a-hardened: reconnection, gap backfill, retry, close-all, orphan detection
7d0473a Implement evolver: evolutionary parameter selection wrapping arena
a200dde Implement arena: parallel strategy tournament with shared market data
0947255 Implement parity-checker: backtest vs live trade comparison
580359b Implement parallel sweep engine with Bun workers
8ee3ba7 Implement storage package: SQLite candle and trade persistence
7e9b8b3 Format and minor Phase 2 cleanup
aa714cc Implement Phase 3a-minimal: BinanceAdapter, LiveDataFeed, LiveExecutor, LiveRunner
03399f6 Phase 3 design: plan docs, interfaces, storage scaffold, boundary updates
6cfde50 Fix 13 audit issues across Phase 2 packages
d39197a Implement all Phase 2 packages: indicators through sweep-engine
f9449c1 Phase 2 design: update stubs and docs to reflect grilling decisions
3893f2d Migrate ESLint to flat config, add boundary checks to pre-commit
067d53a Remove stale oxlintrc.json
bae0946 Switch typecheck scripts from tsc to tsgo
969a1fe Configure oxlint type-aware rules and migrate to tsgo for IDE
d99527d Add ts-reset for stricter global type safety
2e10153 Ban type assertions, add pre-commit hooks and editor config
27ec5ee Scaffold Nx monorepo with 18 packages for Phase 1 foundation
ff6387c Add architecture plan and design docs
6b68b13 first commit
```
