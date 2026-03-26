# Phase 3 — Live Trading & Evolution (High-Level)

Phase 2 delivers a working backtest + sweep pipeline. Phase 3 connects it to the real world.

---

## 3a. Live data infrastructure

### `data-feed` — Live WebSocket variant

- Binance WebSocket kline stream → filters `isClosed` → emits `candle:close` / `candle:update`
- Binance aggTrade stream → emits `tick`
- Binance depth stream → maintains local `OrderBookSnapshot` from diffs
- Gap backfill: async queue pattern (per-symbol-per-timeframe), dedup by `openTime`
- Connection lifecycle: emits `exchange:connected`, `exchange:disconnected`, `exchange:reconnecting`, `exchange:gap`

### `exchange-client` — Binance live + testnet adapters

- `binance-live` variant: real API keys, production endpoints
- `binance-testnet` variant: testnet API keys, testnet endpoints
- WebSocket management: ping/pong, 24h reconnect, listen key renewal (user data stream)
- REST: `getCandles()`, `getOrderBook()`, `getBalance()`, `getFees()`, `placeOrder()`, `cancelOrder()`
- All via Bun native `fetch` and `WebSocket` — no axios/node-fetch

### `order-executor` — LiveExecutor

- Async queue behind sync `submit()`
- Retries with exponential backoff
- Rate limiting (Binance: 1200 requests/min for orders)
- Emits `order:filled` / `order:rejected` when exchange responds

---

## 3b. Live runner

### `live-runner`

- Creates environment: bus, live exchange, live executor, live data-feed
- Calls `StrategyFactory(params, deps)` — same factory as backtest
- Manages lifecycle: start, stop, graceful shutdown (close open positions?)
- Logging: every event, every order, every fill — forensic trail for 3am debugging
- Health monitoring: heartbeat, latency tracking, connection status

### Strategy `getStats()` — live implementation

- Strategy subscribes to `position:closed`, accumulates running `PerformanceMetrics`
- `getStats()` returns live metrics (Phase 2 returns stub zeros)

---

## 3c. Advanced slippage & fills

### Orderbook-based slippage model

- `SlippageModel.type: 'orderbook-based'`
- Uses real book depth from `data-feed.getOrderBook()` to estimate fill price
- Walk the book: for a market buy of Q quantity, sum asks until Q is filled, weighted avg = fill price
- Calibration: compare simulated fills against actual fills from live trading

### Proportional slippage model

- `SlippageModel.type: 'proportional'`
- Slippage scales with position size: `slippageBps = baseBps * (quantity / averageVolume)`

---

## 3d. Data persistence

### Candle storage

- Historical candle database (SQLite or parquet files)
- Sync job: fetches missing candles from Binance REST, appends to store
- `CandleLoader` implementation that reads from local store (replaces fixture loader)
- Dedup and gap detection on stored data

### Trade log persistence

- Every `TradeRecord` written to disk/DB during live trading
- Queryable by date range, symbol, strategy name
- Feeds into reporting dashboards

---

## 3e. Evolution & tournament

### `arena` — Parallel strategy tournament

- Runs N strategy instances simultaneously against live data (paper-trade or small-size)
- Each instance: different params, same `StrategyFactory`
- Tracks live performance per instance over a configurable window
- Reports rankings by configurable metric

### `evolver` — Evolutionary parameter selection

- Watches arena results over evaluation windows
- Kills bottom N% performers
- Mutates survivors' params (gaussian noise on numeric params)
- Spawns new instances from mutated params
- Configurable: mutation rate, population size, evaluation window, survival threshold

### `parity-checker` — Backtest vs reality

- Runs same strategy through backtest-engine on historical data
- Compares trade-by-trade against actual live results (from trade log)
- Diffs: entry price, exit price, fill time, fees, PnL per trade
- Flags divergence > threshold (configurable bps)
- Identifies systematic bias: does backtest consistently overestimate PnL?

---

## 3f. Parallelism

### Sweep parallelism (Bun workers)

- Replace sequential loop in sweep-engine with Bun worker threads
- Each worker runs one `backtest-engine.run()` — isolation already guaranteed by fresh bus/deps per run
- Concurrency limit: `os.cpus().length`
- Worker communication: postMessage with serialized `SweepResult`

---

## 3g. Observability (optional)

### CLI dashboard

- Real-time display of live strategy status
- Open positions, PnL, signal buffer state, risk manager state
- Connection status per stream

### Alerting

- Kill switch triggered → notification (Telegram, Discord, email)
- Connection down > N minutes → alert
- Drawdown approaching threshold → warning

---

## Phase 3 dependency order

```
3a. data-feed (live) + exchange-client (binance adapters)
  → can test with Binance testnet
3b. order-executor (LiveExecutor) + live-runner
  → can run strategies on testnet
3c. slippage models (orderbook-based, proportional)
  → improves backtest accuracy
3d. data persistence (candle store, trade logs)
  → required for parity-checker and long-running arena
3e. arena + evolver + parity-checker
  → the evolutionary loop
3f. sweep parallelism
  → performance optimization, independent of other work
3g. observability
  → quality of life, independent of other work
```

3a and 3b are the critical path. Everything else can be parallelized across team members.
