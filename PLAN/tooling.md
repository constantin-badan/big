# Tooling & Configuration

All Nx, TypeScript, linting, formatting, and testing configuration.

---

## Tech stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, no `any`)
- **Monorepo**: Nx (with `@nx/js` plugin for TS libraries)
- **Testing**: `bun:test` (built-in, no Jest)
- **Linting**: oxlint (with type-aware rules enabled via `--tsconfig`)
- **Formatting**: oxfmt
- **Boundary enforcement**: ESLint with `@nx/enforce-module-boundaries` only (minimal config, exists solely for this rule)

---

## Nx configuration

- Use `@nx/js` for TypeScript libraries
- Set up project references so Nx understands the dependency graph
- Add targets: `build`, `test`, `lint` (oxlint), `format` (oxfmt), `lint:boundaries` (eslint — boundary rules only), `typecheck` (tsc --noEmit)
- Configure Nx caching for build and test targets
- Use `@trading-bot/` as the npm scope for all packages

---

## tsconfig setup

- `tsconfig.base.json` at root with:
  - `strict: true`
  - `noUncheckedIndexedAccess: true`
  - `exactOptionalPropertyTypes: true`
  - `paths` mapping `@trading-bot/*` to each package's `src/index.ts`
- Each package has its own `tsconfig.json` extending base
- Each package has `tsconfig.spec.json` for tests

---

## Linting & formatting config

**oxlint** (`oxlintrc.json` at root):
- Enable type-aware rules via `--tsconfig ./tsconfig.base.json`
- Enable categories: `correctness`, `suspicious`, `pedantic`, `style`
- Deny `no-explicit-any` (aligns with our "no `any`" rule)
- Enable import sorting rules

**oxfmt** (run via `oxfmt --write`):
- Indent: 2 spaces
- Quotes: single
- Semicolons: always
- Print width: 100

**ESLint** (`.eslintrc.json` at root — minimal config, boundary enforcement only):
```json
{
  "root": true,
  "plugins": ["@nx"],
  "overrides": [
    {
      "files": ["*.ts"],
      "rules": {
        "@nx/enforce-module-boundaries": [
          "error",
          {
            "enforceBuildableLibDependency": true,
            "allow": ["@trading-bot/test-utils"],
            "depConstraints": [
              { "sourceTag": "scope:types", "onlyDependOnLibsWithTags": [] },
              { "sourceTag": "scope:event-bus", "onlyDependOnLibsWithTags": ["scope:types"] },
              { "sourceTag": "scope:exchange-client", "onlyDependOnLibsWithTags": ["scope:types"] },
              { "sourceTag": "scope:indicators", "onlyDependOnLibsWithTags": ["scope:types"] },
              { "sourceTag": "scope:data-feed", "onlyDependOnLibsWithTags": ["scope:types", "scope:event-bus", "scope:exchange-client"] },
              { "sourceTag": "scope:position-manager", "onlyDependOnLibsWithTags": ["scope:types", "scope:event-bus", "scope:order-executor", "scope:risk-manager"] },
              { "sourceTag": "scope:risk-manager", "onlyDependOnLibsWithTags": ["scope:types", "scope:event-bus"] },
              { "sourceTag": "scope:order-executor", "onlyDependOnLibsWithTags": ["scope:types", "scope:event-bus", "scope:exchange-client"] },
              { "sourceTag": "scope:scanner", "onlyDependOnLibsWithTags": ["scope:types", "scope:event-bus", "scope:indicators"] },
              { "sourceTag": "scope:strategy", "onlyDependOnLibsWithTags": ["scope:types", "scope:event-bus", "scope:scanner", "scope:position-manager", "scope:risk-manager"] },
              { "sourceTag": "scope:backtest-engine", "onlyDependOnLibsWithTags": ["scope:types", "scope:event-bus", "scope:exchange-client", "scope:strategy"] },
              { "sourceTag": "scope:sweep-engine", "onlyDependOnLibsWithTags": ["scope:types", "scope:backtest-engine", "scope:strategy"] },
              { "sourceTag": "scope:live-runner", "onlyDependOnLibsWithTags": ["scope:types", "scope:event-bus", "scope:exchange-client", "scope:strategy"] },
              { "sourceTag": "scope:arena", "onlyDependOnLibsWithTags": ["scope:types", "scope:live-runner", "scope:reporting"] },
              { "sourceTag": "scope:evolver", "onlyDependOnLibsWithTags": ["scope:types", "scope:arena"] },
              { "sourceTag": "scope:parity-checker", "onlyDependOnLibsWithTags": ["scope:types", "scope:backtest-engine", "scope:reporting"] },
              { "sourceTag": "scope:reporting", "onlyDependOnLibsWithTags": ["scope:types"] }
            ]
          }
        ]
      }
    }
  ]
}
```

Each package's `project.json` must include the corresponding `"tags": ["scope:<package-name>"]`.

**`test-utils` boundary rules:**
- Tagged `scope:test-utils` but has NO `depConstraints` entry — it can import any package (it needs to import interfaces to mock them)
- Listed in the `allow` array so any package's test files can import it
- `@trading-bot/test-utils` must be a `devDependency` only in each package's `package.json`
- **Production code must never import test-utils.** Enforce in CI with: `grep -r "@trading-bot/test-utils" packages/*/src/*.ts packages/*/src/**/*.ts --include="*.ts" --exclude-dir="__tests__"` — this should return zero matches. Nx boundary rules can't distinguish test vs production files, so this CI check is the enforcement layer.

**Dev dependencies at root:**
- `oxlint` (install via `bun add -d oxlint`)
- `oxfmt` (install via `bun add -d oxfmt` or use the `@oxc/oxfmt` package — check latest naming)
- `eslint` + `@nx/eslint-plugin` (only for boundary enforcement)
- Do NOT install any other ESLint plugins, configs, or parsers beyond what `@nx/eslint-plugin` requires

**Nx target setup for the split tooling:**
- `lint` target in each `project.json`: runs `oxlint --tsconfig ./tsconfig.json ./src`
- `format` target at root: runs `oxfmt --write packages/`
- `lint:boundaries` target at root: runs `eslint --no-eslintrc -c .eslintrc.json 'packages/*/src/**/*.ts'` — this is slow and only needs to run in CI or pre-push, not on every save
- `typecheck` target in each `project.json`: runs `tsc --noEmit`

---

## Testing requirements

- Every package must have at least one test file in `src/__tests__/`
- For Phase 1 (types, event-bus, exchange-client, reporting/KahanSum, test-utils): write real unit tests
- For stubs: write a simple "interface is importable" test — just import the type and assert it compiles
- Use `bun:test` (`describe`, `test`, `expect` from `bun:test`)
- Add an Nx target `test` that runs `bun test` for each package
- All package tests should use `@trading-bot/test-utils` for mocks, fixtures, and event capture — not local helpers
- `@trading-bot/test-utils` must be a `devDependency` in each consuming package's `package.json`

---

## Expected verification

After running the scaffold:

1. `bun install` — all workspace deps resolve
2. `npx nx run-many -t typecheck` — zero errors
3. `npx nx run-many -t test` — all tests pass
4. `npx nx run-many -t lint` — zero oxlint warnings
5. `npx nx lint:boundaries` — zero boundary violations
6. `npx nx graph` — shows the dependency graph matching the rules in [architecture.md](./architecture.md)
7. Import any package's types/interfaces from another package using `@trading-bot/package-name`