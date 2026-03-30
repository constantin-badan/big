/**
 * Out-of-sample stress test for tournament winners.
 *
 * Takes the top N winners + top K per template from a tournament,
 * then backtests them on unseen symbols and unseen time periods
 * to detect overfitting.
 *
 * Usage:
 *   bun run cli.ts stress --id <tournament-id>
 *   bun run cli.ts stress                        (uses most recent)
 *   bun run cli.ts stress --symbols 12 --weeks 8
 */
import type {
  BacktestConfig,
  ExchangeConfig,
  PositionManagerConfig,
  RiskConfig,
  Symbol,
  Timeframe,
  TournamentCandidate,
  TournamentState,
  CandidateStageResult,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';
import { createStorage, syncCandles } from '@trading-bot/storage';
import type { ICandleStore } from '@trading-bot/storage';
import { TEMPLATES } from '@trading-bot/strategies';
import { createBacktestEngine } from '@trading-bot/backtest-engine';

import { fetchTopSymbols } from './fetch-top-symbols';
import { createBinanceFetcher } from './fetch-binance';
import { createPrng } from './prng';

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

function computeWarmupMs(timeframes: Timeframe[]): number {
  const maxTfMs = Math.max(...timeframes.map((tf) => TIMEFRAME_MS[tf]));
  return 500 * maxTfMs;
}

// ─── Types ─────────────────────────────────────────────────────────

interface StressArgs {
  id: string | null;
  topN: number;
  perTemplate: number;
  symbolCount: number;
  weekCount: number;
  symbolPoolSize: number;
  exportPath: string | null;
  dbPath: string;
}

interface StressResult {
  candidateId: string;
  templateName: string;
  tournamentPnl: number;
  stressPnl: number;
  stressTrades: number;
  stressProfitableRuns: number;
  stressTotalRuns: number;
  stressAvgPF: number;
  stressAvgSharpe: number;
  stressMaxDD: number;
  degradation: number; // % change from tournament to stress PnL
}

// ─── Arg Parsing ───────────────────────────────────────────────────

function parseArgs(argv: string[]): StressArgs {
  const args: StressArgs = {
    id: null,
    topN: 10,
    perTemplate: 3,
    symbolCount: 10,
    weekCount: 4, // 4 weeks = ~1 month per coin
    symbolPoolSize: 150,
    exportPath: null,
    dbPath: './data/candles.db',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--id' && argv[i + 1]) args.id = argv[++i]!;
    else if (arg === '--top' && argv[i + 1]) args.topN = Number(argv[++i]);
    else if (arg === '--per-template' && argv[i + 1]) args.perTemplate = Number(argv[++i]);
    else if (arg === '--symbols' && argv[i + 1]) args.symbolCount = Number(argv[++i]);
    else if (arg === '--weeks' && argv[i + 1]) args.weekCount = Number(argv[++i]);
    else if (arg === '--export' && argv[i + 1]) args.exportPath = argv[++i]!;
    else if (arg === '--db' && argv[i + 1]) args.dbPath = argv[++i]!;
  }

  return args;
}

// ─── Candidate Selection ───────────────────────────────────────────

/** Reinterpret unknown JSON as typed value without `as` assertion. */
function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

function selectCandidates(
  state: TournamentState,
  topN: number,
  perTemplate: number,
): Array<{ candidate: TournamentCandidate; tournamentPnl: number }> {
  const lastStage = state.completedStages - 1;
  if (lastStage < 0) return [];

  const lastResults = state.stageResults
    .filter((r) => r.stageIndex === lastStage && r.survived)
    .sort((a, b) => b.totalPnl - a.totalPnl);

  const candidateMap = new Map<string, TournamentCandidate>();
  for (const c of state.candidates) {
    candidateMap.set(c.id, c);
  }

  const resultMap = new Map<string, CandidateStageResult>();
  for (const r of lastResults) {
    resultMap.set(r.candidateId, r);
  }

  // Top N overall
  const selected = new Map<string, { candidate: TournamentCandidate; tournamentPnl: number }>();
  for (const r of lastResults.slice(0, topN)) {
    const c = candidateMap.get(r.candidateId);
    if (c) selected.set(c.id, { candidate: c, tournamentPnl: r.totalPnl });
  }

  // Top K per template (may overlap with top N — deduped by Map)
  const byTemplate = new Map<string, CandidateStageResult[]>();
  for (const r of lastResults) {
    const c = candidateMap.get(r.candidateId);
    if (!c) continue;
    const list = byTemplate.get(c.templateName) ?? [];
    list.push(r);
    byTemplate.set(c.templateName, list);
  }

  for (const [, results] of byTemplate) {
    for (const r of results.slice(0, perTemplate)) {
      const c = candidateMap.get(r.candidateId);
      if (c && !selected.has(c.id)) {
        selected.set(c.id, { candidate: c, tournamentPnl: r.totalPnl });
      }
    }
  }

  return [...selected.values()];
}

// ─── Week Generation ───────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function generateRandomWeeks(
  count: number,
  lookbackMs: number,
  random: () => number,
): Array<{ startTime: number; endTime: number }> {
  const now = Date.now();
  const earliest = now - lookbackMs;
  // Available week slots
  const totalWeeks = Math.floor(lookbackMs / WEEK_MS);
  if (totalWeeks <= count) {
    // Return all available weeks
    const weeks: Array<{ startTime: number; endTime: number }> = [];
    for (let i = 0; i < totalWeeks; i++) {
      const start = earliest + i * WEEK_MS;
      weeks.push({ startTime: start, endTime: start + WEEK_MS });
    }
    return weeks;
  }

  // Fisher-Yates partial shuffle to pick `count` unique week indices
  const indices = Array.from({ length: totalWeeks }, (_, i) => i);
  for (let i = indices.length - 1; i > indices.length - 1 - count && i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = temp;
  }

  return indices
    .slice(indices.length - count)
    .sort((a, b) => a - b)
    .map((i) => {
      const start = earliest + i * WEEK_MS;
      return { startTime: start, endTime: start + WEEK_MS };
    });
}

// ─── Backtest Runner ───────────────────────────────────────────────

async function runCandidate(
  candidate: TournamentCandidate,
  symbolWeeks: Map<Symbol, Array<{ startTime: number; endTime: number }>>,
  timeframe: Timeframe,
  riskConfig: RiskConfig,
  exchangeConfig: ExchangeConfig,
  store: ICandleStore,
): Promise<{
  totalPnl: number;
  totalTrades: number;
  profitableRuns: number;
  totalRuns: number;
  avgPF: number;
  avgSharpe: number;
  maxDD: number;
}> {
  const templateMap = new Map(TEMPLATES.map((t) => [t.name, t]));
  const template = templateMap.get(candidate.templateName);
  if (!template) throw new Error(`Unknown template: ${candidate.templateName}`);

  const trailingActivation = candidate.pmParams.trailingActivationPct ?? 0;
  const pmConfig: PositionManagerConfig = {
    defaultStopLossPct: candidate.pmParams.stopLossPct ?? 2,
    defaultTakeProfitPct: candidate.pmParams.takeProfitPct ?? 4,
    trailingStopEnabled: trailingActivation > 0,
    trailingStopActivationPct: trailingActivation,
    trailingStopDistancePct: candidate.pmParams.trailingDistancePct ?? 0.5,
    maxHoldTimeMs: (candidate.pmParams.maxHoldTimeHours ?? 4) * 3_600_000,
    breakevenActivationPct: candidate.pmParams.breakevenPct ?? 0,
  };

  const loader = (sym: Symbol, tf: Timeframe, start: number, end: number) =>
    Promise.resolve(store.getCandles(sym, tf, start, end));

  let totalPnl = 0;
  let totalTrades = 0;
  let profitableRuns = 0;
  let totalRuns = 0;
  let pfSum = 0;
  let sharpeSum = 0;
  let worstDD = 0;

  const extraTimeframes = template.requiredTimeframes ?? [];
  const allTimeframes = [timeframe, ...extraTimeframes.filter((tf) => tf !== timeframe)];

  // Each symbol gets its own random weeks — run 1 symbol × 1 week per backtest
  for (const [symbol, weeks] of symbolWeeks) {
    const factory = template.createFactory([symbol], timeframe, riskConfig, pmConfig);

    for (const week of weeks) {
      const warmupMs = computeWarmupMs(allTimeframes);
      const btConfig: BacktestConfig = {
        startTime: week.startTime,
        endTime: week.endTime,
        symbols: [symbol],
        timeframes: allTimeframes,
        warmupMs,
      };

      const engine = createBacktestEngine(loader, exchangeConfig);
      const result = await engine.run(factory, candidate.scannerParams, btConfig);

      const runPnl = result.finalBalance - result.initialBalance;
      totalPnl += runPnl;
      totalTrades += result.metrics.totalTrades;
      totalRuns += 1;
      if (runPnl > 0) profitableRuns += 1;
      pfSum += Math.min(result.metrics.profitFactor, 100);
      sharpeSum += result.metrics.sharpeRatio;
      if (result.metrics.maxDrawdown > worstDD) worstDD = result.metrics.maxDrawdown;
    }
  }

  return {
    totalPnl,
    totalTrades,
    profitableRuns,
    totalRuns,
    avgPF: totalRuns > 0 ? pfSum / totalRuns : 0,
    avgSharpe: totalRuns > 0 ? sharpeSum / totalRuns : 0,
    maxDD: worstDD,
  };
}

// ─── Display ───────────────────────────────────────────────────────

function printResults(results: StressResult[]): void {
  // Sort by stress PnL
  const sorted = [...results].sort((a, b) => b.stressPnl - a.stressPnl);

  const passed = sorted.filter((r) => r.stressPnl > 0);
  const failed = sorted.filter((r) => r.stressPnl <= 0);

  console.log('');
  console.log(`=== STRESS TEST RESULTS ===`);
  console.log(`Passed (profitable on unseen data): ${String(passed.length)}/${String(sorted.length)}`);
  console.log('');

  if (passed.length > 0) {
    console.log('--- PASSED (likely robust) ---');
    for (const r of passed) {
      const arrow = r.degradation < -20 ? ' ⚠ degraded' : '';
      console.log(`  ${r.candidateId} [${r.templateName}]`);
      console.log(`    Tournament: $${r.tournamentPnl.toFixed(2)}`);
      console.log(`    Stress:     $${r.stressPnl.toFixed(2)}  (${r.degradation > 0 ? '+' : ''}${r.degradation.toFixed(0)}%)${arrow}`);
      const avgTpd = r.stressTotalRuns > 0 ? (r.stressTrades / (r.stressTotalRuns * 7)).toFixed(1) : '?';
      const avgPnl = r.stressTrades > 0 ? (r.stressPnl / r.stressTrades).toFixed(2) : '?';
      console.log(`    Trades: ${String(r.stressTrades)} (${avgTpd}/day, avg $${avgPnl})  Profitable: ${String(r.stressProfitableRuns)}/${String(r.stressTotalRuns)} runs  AvgPF: ${r.stressAvgPF.toFixed(2)}  MaxDD: ${r.stressMaxDD.toFixed(1)}%`);
      console.log('');
    }
  }

  if (failed.length > 0) {
    console.log('--- FAILED (likely overfit) ---');
    for (const r of failed) {
      const avgTpd = r.stressTotalRuns > 0 ? (r.stressTrades / (r.stressTotalRuns * 7)).toFixed(1) : '?';
      const avgPnl = r.stressTrades > 0 ? (r.stressPnl / r.stressTrades).toFixed(2) : '?';
      console.log(`  ${r.candidateId} [${r.templateName}]`);
      console.log(`    Tournament: $${r.tournamentPnl.toFixed(2)}`);
      console.log(`    Stress:     $${r.stressPnl.toFixed(2)}  (${r.degradation.toFixed(0)}%)`);
      console.log(`    Trades: ${String(r.stressTrades)} (${avgTpd}/day, avg $${avgPnl})  Profitable: ${String(r.stressProfitableRuns)}/${String(r.stressTotalRuns)} runs`);
      console.log('');
    }
  }

  // Summary table
  console.log('--- SUMMARY ---');
  console.log(`  Robust:  ${String(passed.length)} strategies profitable on unseen data`);
  console.log(`  Overfit: ${String(failed.length)} strategies lost money on unseen data`);
  if (passed.length > 0) {
    const best = passed[0]!;
    console.log(`  Best:    ${best.candidateId} — $${best.stressPnl.toFixed(2)} stress PnL`);
  }
}

// ─── Entry Point ───────────────────────────────────────────────────

export async function runStressTest(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // Resolve tournament ID
  const storage = createStorage(args.dbPath);
  if (!args.id) {
    const ids = storage.tournaments.list();
    if (ids.length === 0) {
      console.error('No tournaments found. Run one first.');
      storage.close();
      return;
    }
    args.id = ids[0]!;
    console.log(`Using most recent tournament: ${args.id}`);
  }

  // Load tournament state
  const raw = storage.tournaments.load(args.id);
  if (!raw) {
    console.error(`Tournament not found: ${args.id}`);
    storage.close();
    return;
  }
  const state = unsafeCast<TournamentState>(raw);
  const timeframe = state.config.timeframe;

  // Select candidates to stress test
  const candidates = selectCandidates(state, args.topN, args.perTemplate);
  if (candidates.length === 0) {
    console.error('No surviving candidates found in tournament.');
    storage.close();
    return;
  }

  console.log(`Selected ${String(candidates.length)} candidates for stress testing`);
  console.log(`  Top ${String(args.topN)} overall + top ${String(args.perTemplate)} per template (deduplicated)`);

  // Fetch symbols by volume and pick random ones
  console.log(`\nFetching top ${String(args.symbolPoolSize)} symbols by volume...`);
  const allSymbols = await fetchTopSymbols(args.symbolPoolSize);

  const random = createPrng(Date.now());
  const shuffled = [...allSymbols];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = temp;
  }
  const stressSymbols = shuffled.slice(0, args.symbolCount);
  console.log(`Stress symbols (${String(stressSymbols.length)} unseen): ${stressSymbols.join(', ')}`);

  // Generate random weeks per symbol (each coin gets its own random weeks)
  const lookback90d = 90 * 24 * 60 * 60 * 1000;
  const symbolWeeks = new Map<Symbol, Array<{ startTime: number; endTime: number }>>();
  console.log(`\nStress weeks (${String(args.weekCount)} per symbol):`);
  for (const symbol of stressSymbols) {
    const weeks = generateRandomWeeks(args.weekCount, lookback90d, random);
    symbolWeeks.set(symbol, weeks);
    const weekStrs = weeks.map((w) => new Date(w.startTime).toISOString().slice(5, 10)).join(', ');
    console.log(`  ${String(symbol)}: ${weekStrs}`);
  }

  const totalRuns = stressSymbols.length * args.weekCount;
  console.log(`Total: ${String(totalRuns)} runs (${String(stressSymbols.length)} symbols x ${String(args.weekCount)} weeks each)`);

  // Collect all timeframes needed (base + any requiredTimeframes from templates)
  const templateMap = new Map(TEMPLATES.map((t) => [t.name, t]));
  const allTimeframes = new Set<Timeframe>([timeframe]);
  for (const { candidate } of candidates) {
    const tmpl = templateMap.get(candidate.templateName);
    if (tmpl?.requiredTimeframes) {
      for (const tf of tmpl.requiredTimeframes) allTimeframes.add(tf);
    }
  }

  // Sync candle data for stress symbols — full 90d + warmup buffer
  console.log('\nSyncing candle data for stress test symbols...');
  const fetcher = createBinanceFetcher();
  const maxWarmup = computeWarmupMs([...allTimeframes]);
  const syncStart = Date.now() - lookback90d - maxWarmup;
  const syncEnd = Date.now();

  const syncRequests = stressSymbols.flatMap((symbol) =>
    [...allTimeframes].map((tf) => ({
      symbol,
      timeframe: tf,
      startTime: syncStart,
      endTime: syncEnd,
    })),
  );

  const syncResults = await syncCandles(storage.candles, fetcher, syncRequests);
  const totalFetched = syncResults.reduce((sum, r) => sum + r.fetchedCandles, 0);
  console.log(`Synced ${String(totalFetched)} candles across ${String(syncResults.length)} requests`);

  // Build exchange config matching tournament
  const exchangeConfig = state.config.exchangeConfig;
  const riskConfig = state.config.riskConfig;

  // Run stress tests
  console.log(`\nRunning ${String(candidates.length)} candidates x ${String(totalRuns)} runs each...`);
  const results: StressResult[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const { candidate, tournamentPnl } = candidates[i]!;
    const progress = `[${String(i + 1)}/${String(candidates.length)}]`;
    process.stdout.write(`\r  ${progress} ${candidate.id}...`);

    const r = await runCandidate(
      candidate,
      symbolWeeks,
      timeframe,
      riskConfig,
      exchangeConfig,
      storage.candles,
    );

    const degradation = tournamentPnl !== 0
      ? ((r.totalPnl - tournamentPnl) / Math.abs(tournamentPnl)) * 100
      : 0;

    results.push({
      candidateId: candidate.id,
      templateName: candidate.templateName,
      tournamentPnl,
      stressPnl: r.totalPnl,
      stressTrades: r.totalTrades,
      stressProfitableRuns: r.profitableRuns,
      stressTotalRuns: r.totalRuns,
      stressAvgPF: r.avgPF,
      stressAvgSharpe: r.avgSharpe,
      stressMaxDD: r.maxDD,
      degradation,
    });
  }

  console.log('\r' + ' '.repeat(60) + '\r'); // clear progress line

  storage.close();
  printResults(results);

  if (args.exportPath) {
    const passed = results
      .filter((r) => r.stressPnl > 0)
      .sort((a, b) => b.stressPnl - a.stressPnl);

    const candidateMap = new Map(
      candidates.map(({ candidate }) => [candidate.id, candidate]),
    );

    const symbolWeeksJson: Record<string, Array<{ start: string; end: string }>> = {};
    for (const [sym, weeks] of symbolWeeks) {
      symbolWeeksJson[String(sym)] = weeks.map((w) => ({
        start: new Date(w.startTime).toISOString().slice(0, 10),
        end: new Date(w.endTime).toISOString().slice(0, 10),
      }));
    }

    const output = {
      exportedAt: new Date().toISOString(),
      tournamentId: args.id,
      stressSymbols: stressSymbols.map(String),
      symbolWeeks: symbolWeeksJson,
      robust: passed.map((r) => {
        const c = candidateMap.get(r.candidateId)!;
        return {
          candidateId: r.candidateId,
          templateName: r.templateName,
          scannerParams: c.scannerParams,
          pmParams: c.pmParams,
          tournament: { pnl: r.tournamentPnl },
          stress: {
            pnl: r.stressPnl,
            trades: r.stressTrades,
            avgTradesPerDay: r.stressTotalRuns > 0 ? r.stressTrades / (r.stressTotalRuns * 7) : 0,
            avgTradePnl: r.stressTrades > 0 ? r.stressPnl / r.stressTrades : 0,
            profitableRuns: r.stressProfitableRuns,
            totalRuns: r.stressTotalRuns,
            avgProfitFactor: r.stressAvgPF,
            avgSharpe: r.stressAvgSharpe,
            maxDrawdown: r.stressMaxDD,
            degradation: r.degradation,
          },
        };
      }),
    };

    await Bun.write(args.exportPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`\nExported ${String(passed.length)} robust strategies to ${args.exportPath}`);
  }
}
