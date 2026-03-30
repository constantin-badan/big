# Remaining Work

Items deferred from the current session. Ordered by priority.

## Pre-Production (required before live trading)

### Safety Stop — exchange-side crash net
Position-manager places a `STOP_MARKET` on the exchange at 2× SL distance when entering a position. Cancels on normal exit. Only triggers if the bot is dead. Config fields exist (`safetyStopEnabled`, `safetyStopMultiplier`) — code not written.
- **File:** `packages/position-manager/src/position-manager.ts`
- **Effort:** 3-4 hours

### Fix sim exchange Date.now() timestamps
`BacktestSimExchange.makeFilled()` uses `Date.now()` for order timestamps instead of simulation time (candle timestamp). This makes exit timestamps non-deterministic and incomparable with entry timestamps. Breaks trade ordering assertions in E2E tests and makes parity checking unreliable.
- **File:** `packages/backtest-engine/src/backtest-sim-exchange.ts`
- **Effort:** 1 hour

### Testnet validation
Run a winning strategy from the tournament on Binance testnet via LiveRunner. Validates the full end-to-end flow: exchange → data-feed → scanner → strategy → position-manager → executor → exchange. Requires testnet API key.
- **Effort:** 2-3 hours

## Strategy Development

### Multi-timeframe strategies
4h trend filter + 1m entry timing. ADR-9 pattern exists (multiple scanners in Strategy.scanners[]), but no template wires it. Requires a ScannerTemplate that creates 2 scanners on different timeframes with a custom signalMerge.
- **Effort:** 2-3 hours

### Larger symbol pool
Fetch top 50-100 symbols by 24h volume from Binance REST (`/fapi/v1/ticker/24hr`). Use as the tournament's symbolPool instead of hardcoded 4 coins. More diverse testing surface.
- **Effort:** 1 hour

## Production Hardening

### 24h WebSocket hot-swap
Zero-gap WebSocket rotation every 24h. Open second connection, verify messages, swap dispatch map, close old. Currently reconnects on disconnect with a brief gap (backfill handles missed candles).
- **Effort:** 4-5 hours

### REST rate limiting
No throttling for REST calls (getBalance, getPositions, getCandles). Binance enforces 1200 req weight/min. Add a token bucket to exchange-client for REST requests.
- **Effort:** 2-3 hours

## Quality of Life

### CLI dashboard
Rich TUI: open positions, PnL, signal buffer, risk state, connection status per stream. All event data exists — just needs terminal UI.

### Alerting
Kill switch → Telegram/Discord. Connection down > N min → alert. Drawdown approaching threshold → warning.

### Metrics aggregation
Prometheus/StatsD exporter if needed.
