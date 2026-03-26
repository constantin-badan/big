# Monorepo Foundation Scaffold — Prompt

Use this prompt with an AI coding assistant (or Claude Code) to lay down the Bun + Nx monorepo foundation for the scalper bot. Feed the referenced docs as context alongside this prompt.

**Reference docs (include all of these):**

- [architecture.md](./architecture.md) — Architectural decisions and rationale
- [types.md](./types.md) — All shared domain types
- [interfaces.md](./interfaces.md) — All package interface definitions
- [tooling.md](./tooling.md) — Nx, tsconfig, linting, formatting, testing config

---

## Prompt

You are scaffolding the foundation of a **Bun + TypeScript + Nx monorepo** for a crypto trading bot platform. The goal is to create the package structure, core interfaces, shared types, event system, and testing infrastructure — **no strategy logic yet**, just the building blocks that everything else will depend on.

Read the reference docs above carefully before starting. They contain all type definitions, interface contracts, architectural decisions, and tooling configuration.

### Monorepo structure

Create an Nx workspace with the following packages under `packages/`. Each package is an Nx library with its own `package.json`, `tsconfig.json`, `src/index.ts` barrel export, and `src/__tests__/` directory.

```
trading-bot/
├── nx.json
├── tsconfig.base.json
├── oxlintrc.json
├── .eslintrc.json               # ONLY @nx/enforce-module-boundaries
├── package.json                  # workspace root
├── packages/
│   ├── types/                    # Shared domain types
│   ├── exchange-client/          # IExchange interface + factory
│   ├── event-bus/                # Typed event emitter
│   ├── indicators/               # Technical indicator library
│   ├── data-feed/                # Candle + tick stream abstraction
│   ├── position-manager/         # Position lifecycle management
│   ├── risk-manager/             # Hard risk gates
│   ├── order-executor/           # Order placement with retries
│   ├── scanner/                  # Signal generation framework
│   ├── strategy/                 # Strategy composition framework
│   ├── backtest-engine/          # Event-driven backtester
│   ├── sweep-engine/             # Parameter sweep + walk-forward
│   ├── live-runner/              # Live/testnet execution loop
│   ├── arena/                    # Parallel strategy tournament
│   ├── evolver/                  # Evolutionary param selection
│   ├── parity-checker/           # Backtest vs reference engine diff
│   ├── reporting/                # Metrics, equity curves, logs
│   └── test-utils/               # Shared test infrastructure (devDependency only)
```

### Phase 1 — what to implement now

Only implement the foundational packages that everything else depends on. Stub the rest with just the interface/type exports and a `TODO` placeholder.

**Fully implement:**

1. **`types`** — All shared domain types (see [types.md](./types.md))
2. **`event-bus`** — Typed event emitter (see [interfaces.md](./interfaces.md#event-bus))
3. **`exchange-client`** — `IExchange` interface + factory pattern (see [interfaces.md](./interfaces.md#exchange-client))
4. **`reporting`** — `KahanSum` utility class fully implemented; remaining reporting interfaces stubbed (see [interfaces.md](./interfaces.md#reporting))
5. **`test-utils`** — Shared test infrastructure (see [interfaces.md](./interfaces.md#test-utils))

**Stub with interfaces + types only:**

5. **`indicators`** — `IIndicator` interface + `IndicatorFactory` type
6. **`data-feed`** — `IDataFeed` interface
7. **`position-manager`** — `IPositionManager` interface
8. **`risk-manager`** — `IRiskManager` interface
9. **`order-executor`** — `IOrderExecutor` interface
10. **`scanner`** — `IScanner` interface + `ScannerFactory` type
11. **`strategy`** — `IStrategy` interface + `StrategyFactory`, `SignalMerge` types
12. **`backtest-engine`** — `IBacktestEngine` interface
13. **`sweep-engine`** — `ISweepEngine` interface
14. **`live-runner`** — stub
15. **`arena`** — stub
16. **`evolver`** — stub
17. **`parity-checker`** — stub

### What NOT to do

- Do NOT implement any Binance API calls yet
- Do NOT implement any indicators yet
- Do NOT implement any strategy logic
- Do NOT install axios/node-fetch — we'll use Bun's native `fetch` and `WebSocket`
- Do NOT add a database or persistence layer yet
- Do NOT add a UI or CLI yet

### File structure for a fully implemented package (event-bus example)

```
packages/event-bus/
├── package.json
├── tsconfig.json
├── tsconfig.spec.json
├── project.json
├── src/
│   ├── index.ts              # barrel: export { EventBus } from './event-bus'; export type { ... }
│   ├── event-bus.ts           # implementation
│   ├── types.ts               # TradingEventMap, IEventBus
│   └── __tests__/
│       └── event-bus.test.ts  # unit tests
```

### File structure for a stub package (scanner example)

```
packages/scanner/
├── package.json
├── tsconfig.json
├── tsconfig.spec.json
├── project.json
├── src/
│   ├── index.ts              # barrel: export type { IScanner, IScannerConfig, ScannerFactory }
│   ├── types.ts              # IScanner, IScannerConfig, ScannerFactory
│   └── __tests__/
│       └── scanner.test.ts   # import test only
```

### Go

Read all reference docs, then create the full monorepo scaffold following these specifications. Refer to `architecture.md` for dependency rules and critical constraints, `types.md` for all type definitions, `interfaces.md` for all package contracts, and `tooling.md` for all configuration.
