# trading-bot

Crypto trading bot platform — Bun + TypeScript + Nx monorepo.

## Status

Phase 1: Foundation scaffold (in progress)

## Plan

Architecture decisions, type definitions, package interfaces, and tooling config are documented in [`PLAN/`](./PLAN/):

- [`architecture.md`](./PLAN/architecture.md) — ADRs: sync event bus, reactive components, signal routing, factory patterns
- [`types.md`](./PLAN/types.md) — Shared domain types (market data, orders, positions, signals, config)
- [`interfaces.md`](./PLAN/interfaces.md) — All package interface contracts
- [`tooling.md`](./PLAN/tooling.md) — Nx, tsconfig, oxlint, oxfmt, boundary enforcement
- [`scaffold-prompt.md`](./PLAN/scaffold-prompt.md) — Phase 1 build spec

## Tech stack

- **Runtime**: Bun
- **Language**: TypeScript (strict, no `any`)
- **Monorepo**: Nx
- **Testing**: bun:test
- **Linting**: oxlint
- **Formatting**: oxfmt
- **Boundary enforcement**: ESLint (@nx/enforce-module-boundaries only)
