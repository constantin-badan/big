/**
 * Parity test: run our backtest and generate a Pine script with
 * embedded results for comparison against TradingView.
 *
 * Usage:
 *   bun run packages/pine-gen/src/parity.ts robust.json ./pine-parity/
 *
 * Locks everything to BTCUSDT, 5m, January 2026 for apples-to-apples comparison.
 */
import type {
  BacktestConfig,
  PositionManagerConfig,
  RiskConfig,
  Symbol,
  Timeframe,
  TradeRecord,
  BacktestResult,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';
import { createStorage, syncCandles } from '@trading-bot/storage';
import { createBacktestEngine } from '@trading-bot/backtest-engine';

import { createBinanceFetcher } from '@trading-bot/runner';
import { generatePineScript } from './generator';

// ─── Constants ─────────────────────────────────────────────────

const SYMBOL: Symbol = toSymbol('BTCUSDT');
const TIMEFRAME: Timeframe = '5m';
// Last 4 complete days (TV free tier allows ~5 days of 5m data)
const TODAY = new Date();
const PARITY_END_DATE = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate())); // today 00:00 UTC
const PARITY_START_DATE = new Date(PARITY_END_DATE.getTime() - 4 * 24 * 60 * 60 * 1000); // 4 days back
const PARITY_START = PARITY_START_DATE.getTime();
const PARITY_END = PARITY_END_DATE.getTime();
// 90 days warmup for indicator convergence. The engine resets PM state
// after warmup so stale positions don't leak into the real period.
const WARMUP_MS = 90 * 24 * 60 * 60 * 1000;

const INITIAL_BALANCE = 10_000;
const FEE_MAKER = 0.0002;
const FEE_TAKER = 0.0004;
const SLIPPAGE_BPS = 5;
const POSITION_SIZE_PCT = 5;

const DB_PATH = './data/candles.db';

// ─── Types ─────────────────────────────────────────────────────

interface StrategyConfig {
  candidateId?: string;
  templateName: string;
  scannerParams: Record<string, number>;
  pmParams: Record<string, number>;
}

interface RobustJson {
  robust: StrategyConfig[];
}

// ─── Helpers ───────────────────────────────────────────────────

/** Reinterpret unknown JSON as typed value without `as` assertion. */
function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatTradeForComment(t: TradeRecord, idx: number): string {
  const dir = t.side === 'LONG' ? 'L' : 'S';
  const entry = formatDate(t.entryTime);
  const exit = formatDate(t.exitTime);
  return `//   #${String(idx + 1).padStart(3)} ${dir} entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} pnl=${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} fees=${t.fees.toFixed(2)} ${t.exitReason}  ${entry} -> ${exit}`;
}

// ─── Backtest Runner ───────────────────────────────────────────

async function runParityBacktest(config: StrategyConfig): Promise<BacktestResult> {
  // Dynamically import the TEMPLATES registry
  const { TEMPLATES } = await import('@trading-bot/strategies');

  const template = TEMPLATES.find((t) => t.name === config.templateName);
  if (!template) throw new Error(`Unknown template: ${config.templateName}`);

  const riskConfig: RiskConfig = {
    maxPositionSizePct: POSITION_SIZE_PCT,
    maxConcurrentPositions: 1,
    maxDailyLossPct: 10,
    maxDrawdownPct: 20,
    maxDailyTrades: 100,
    cooldownAfterLossMs: 0,
    leverage: 1,
    initialBalance: INITIAL_BALANCE,
  };

  const trailingActivation = config.pmParams.trailingActivationPct ?? 0;
  const pmConfig: PositionManagerConfig = {
    defaultStopLossPct: config.pmParams.stopLossPct ?? 2,
    defaultTakeProfitPct: config.pmParams.takeProfitPct ?? 4,
    trailingStopEnabled: trailingActivation > 0,
    trailingStopActivationPct: trailingActivation,
    trailingStopDistancePct: config.pmParams.trailingDistancePct ?? 0.5,
    maxHoldTimeMs: (config.pmParams.maxHoldTimeHours ?? 4) * 3_600_000,
    breakevenActivationPct: config.pmParams.breakevenPct ?? 0,
  };

  const factory = template.createFactory([SYMBOL], TIMEFRAME, riskConfig, pmConfig);

  const storage = createStorage(DB_PATH);
  const loader = (sym: Symbol, tf: Timeframe, start: number, end: number) =>
    Promise.resolve(storage.candles.getCandles(sym, tf, start, end));

  const extraTimeframes = template.requiredTimeframes ?? [];
  const allTimeframes: Timeframe[] = [TIMEFRAME, ...extraTimeframes.filter((tf) => tf !== TIMEFRAME)];

  const btConfig: BacktestConfig = {
    startTime: PARITY_START,
    endTime: PARITY_END,
    symbols: [SYMBOL],
    timeframes: allTimeframes,
    warmupMs: WARMUP_MS,
  };

  const engine = createBacktestEngine(loader, {
    type: 'backtest-sim',
    feeStructure: { maker: FEE_MAKER, taker: FEE_TAKER },
    slippageModel: { type: 'fixed', fixedBps: SLIPPAGE_BPS },
    initialBalance: INITIAL_BALANCE,
  });

  const result = await engine.run(factory, config.scannerParams, btConfig);
  storage.close();
  return result;
}

// ─── Pine Script with Parity Results ───────────────────────────

function generateParityPine(config: StrategyConfig, result: BacktestResult): string {
  const parityConfig = {
    ...config,
    dateRange: {
      startYear: PARITY_START_DATE.getUTCFullYear(),
      startMonth: PARITY_START_DATE.getUTCMonth() + 1,
      startDay: PARITY_START_DATE.getUTCDate(),
      endYear: PARITY_END_DATE.getUTCFullYear(),
      endMonth: PARITY_END_DATE.getUTCMonth() + 1,
      endDay: PARITY_END_DATE.getUTCDate(),
    },
  };
  const basePine = generatePineScript(parityConfig);

  const m = result.metrics;
  const trades = result.trades.sort((a, b) => a.entryTime - b.entryTime);

  const header = [
    `// ═══════════════════════════════════════════════════════════`,
    `// PARITY TEST — compare these results against TradingView`,
    `// ═══════════════════════════════════════════════════════════`,
    `// Symbol:    BTCUSDT`,
    `// Timeframe: 5m`,
    `// Period:    ${PARITY_START_DATE.toISOString().slice(0, 10)} -> ${PARITY_END_DATE.toISOString().slice(0, 10)}`,
    `// Capital:   $${String(INITIAL_BALANCE)}`,
    `// Position:  ${String(POSITION_SIZE_PCT)}% of equity`,
    `// Fees:      maker ${String(FEE_MAKER * 100)}% / taker ${String(FEE_TAKER * 100)}%`,
    `// Slippage:  ${String(SLIPPAGE_BPS)} bps`,
    `//`,
    `// ─── OUR BACKTEST RESULTS ───────────────────────────────`,
    `// Final Balance:  $${result.finalBalance.toFixed(2)}`,
    `// Net PnL:        $${(result.finalBalance - result.initialBalance).toFixed(2)}`,
    `// Total Trades:   ${String(m.totalTrades)}`,
    `// Win Rate:       ${(m.winRate * 100).toFixed(1)}%`,
    `// Profit Factor:  ${Math.min(m.profitFactor, 100).toFixed(2)}`,
    `// Max Drawdown:   ${m.maxDrawdown.toFixed(2)}%`,
    `// Avg Win:        $${m.avgWin.toFixed(2)}`,
    `// Avg Loss:       $${m.avgLoss.toFixed(2)}`,
    `// Total Fees:     $${m.totalFees.toFixed(2)}`,
    `// Total Slippage: $${m.totalSlippage.toFixed(2)}`,
    `//`,
    `// ─── TRADE LOG (${String(trades.length)} trades) ────────────────────────`,
  ];

  for (let i = 0; i < trades.length; i++) {
    header.push(formatTradeForComment(trades[i]!, i));
  }

  header.push(`// ═══════════════════════════════════════════════════════════`);
  header.push(``);

  return header.join('\n') + '\n' + basePine;
}

// ─── Sync Data ─────────────────────────────────────────────────

async function ensureData(): Promise<void> {
  const storage = createStorage(DB_PATH);
  const fetcher = createBinanceFetcher();

  console.log(`Syncing BTCUSDT 5m data for ${PARITY_START_DATE.toISOString().slice(0, 10)} -> ${PARITY_END_DATE.toISOString().slice(0, 10)} (+ warmup)...`);
  const syncResults = await syncCandles(storage.candles, fetcher, [{
    symbol: SYMBOL,
    timeframe: TIMEFRAME,
    startTime: PARITY_START - WARMUP_MS,
    endTime: PARITY_END,
  }]);

  const fetched = syncResults.reduce((s, r) => s + r.fetchedCandles, 0);
  if (fetched > 0) {
    console.log(`  Fetched ${String(fetched)} candles`);
  } else {
    console.log('  Data already cached');
  }

  storage.close();
}

// ─── Entry Point ───────────────────────────────────────────────

export async function runParity(inputPath: string, outputDir: string): Promise<void> {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outputDir, { recursive: true });

  const data = unsafeCast<RobustJson>(await Bun.file(inputPath).json());

  if (data.robust.length === 0) {
    console.error('No strategies found in input file.');
    return;
  }

  // Ensure candle data is available
  await ensureData();

  console.log(`\nRunning ${String(data.robust.length)} parity backtests (BTCUSDT 5m, ${PARITY_START_DATE.toISOString().slice(0, 10)} -> ${PARITY_END_DATE.toISOString().slice(0, 10)})...\n`);

  for (const entry of data.robust) {
    const label = entry.candidateId ?? entry.templateName;
    process.stdout.write(`  ${label}...`);

    const result = await runParityBacktest(entry);
    const pine = generateParityPine(entry, result);

    const filename = `${label}-parity.pine`;
    const outPath = `${outputDir}/${filename}`;
    await Bun.write(outPath, pine);

    const pnl = result.finalBalance - result.initialBalance;
    console.log(` ${String(result.metrics.totalTrades)} trades, PnL $${pnl.toFixed(2)} -> ${outPath}`);
  }

  console.log('\nDone. Open each .pine file in TradingView:');
  console.log('  1. Set chart to BTCUSDT, 5m');
  console.log(`  2. Date range is auto-filtered: ${PARITY_START_DATE.toISOString().slice(0, 10)} -> ${PARITY_END_DATE.toISOString().slice(0, 10)}`);
  console.log('  3. Compare TV results against the comments at the top');
}

// ─── CLI ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputDir = process.argv[3] ?? './pine-parity';

  if (!inputPath) {
    console.error('Usage: bun run pine-gen/src/parity.ts <robust.json> [output-dir]');
    console.error('');
    console.error('Runs backtests on BTCUSDT 5m for the last 4 days and generates Pine scripts');
    console.error('with embedded results for parity testing against TradingView.');
    process.exit(1);
  }

  await runParity(inputPath, outputDir);
}

main().catch((err) => {
  console.error('Parity test failed:', err);
  process.exit(1);
});
