/**
 * Tournament results viewer.
 *
 * Loads saved tournament state from SQLite and displays:
 *   --list                     List all past tournaments
 *   --id <id> --top <N>        Show top N winners from a tournament
 *   --id <id> --by-template    Show best candidate per template
 *   --id <id> --export <path>  Export winning configs as JSON
 */
import type {
  CandidateStageResult,
  TournamentCandidate,
  TournamentState,
} from '@trading-bot/types';
import { createStorage } from '@trading-bot/storage';

// ─── Arg Parsing ───────────────────────────────────────────────────

interface ResultsArgs {
  list: boolean;
  id: string | null;
  top: number;
  byTemplate: boolean;
  exportPath: string | null;
  dbPath: string;
}

function parseArgs(argv: string[]): ResultsArgs {
  const args: ResultsArgs = {
    list: false,
    id: null,
    top: 10,
    byTemplate: false,
    exportPath: null,
    dbPath: './data/candles.db',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') {
      args.list = true;
    } else if (arg === '--id' && argv[i + 1]) {
      args.id = argv[++i]!;
    } else if (arg === '--top' && argv[i + 1]) {
      args.top = Number(argv[++i]);
    } else if (arg === '--by-template') {
      args.byTemplate = true;
    } else if (arg === '--export' && argv[i + 1]) {
      args.exportPath = argv[++i]!;
    } else if (arg === '--db' && argv[i + 1]) {
      args.dbPath = argv[++i]!;
    }
  }

  return args;
}

// ─── Helpers ───────────────────────────────────────────────────────

interface RankedCandidate {
  rank: number;
  candidate: TournamentCandidate;
  lastStageResult: CandidateStageResult;
}

function getFinalRankings(state: TournamentState): RankedCandidate[] {
  const lastStage = state.completedStages - 1;
  if (lastStage < 0) return [];

  const lastResults = state.stageResults
    .filter((r) => r.stageIndex === lastStage && r.survived)
    .sort((a, b) => b.totalPnl - a.totalPnl);

  const candidateMap = new Map<string, TournamentCandidate>();
  for (const c of state.candidates) {
    candidateMap.set(c.id, c);
  }

  return lastResults
    .filter((r) => candidateMap.has(r.candidateId))
    .map((r, i) => ({
      rank: i + 1,
      candidate: candidateMap.get(r.candidateId)!,
      lastStageResult: r,
    }));
}

function formatCandidate(rc: RankedCandidate): string {
  const c = rc.candidate;
  const r = rc.lastStageResult;
  const scannerStr = Object.entries(c.scannerParams)
    .map(([k, v]) => `${k}=${String(Math.round(v))}`)
    .join(', ');
  const slPct = c.pmParams.stopLossPct?.toFixed(1) ?? '?';
  const tpPct = c.pmParams.takeProfitPct?.toFixed(1) ?? '?';
  const holdH = c.pmParams.maxHoldTimeHours?.toFixed(0) ?? '?';

  const avgPF = r.avgProfitFactor != null ? r.avgProfitFactor.toFixed(2) : '?';
  const avgSharpe = r.avgSharpe != null ? r.avgSharpe.toFixed(2) : '?';
  const maxDD = r.maxDrawdown != null ? r.maxDrawdown.toFixed(1) : '?';
  const pnl = r.totalPnl != null ? r.totalPnl.toFixed(2) : '?';

  return [
    `  #${String(rc.rank)} ${c.id}`,
    `     PnL: $${pnl}  |  Trades: ${String(r.totalTrades)}  |  Profitable weeks: ${String(r.profitableWeeks)}/${String(r.totalWeeks)}`,
    `     Avg PF: ${avgPF}  |  Avg Sharpe: ${avgSharpe}  |  Max DD: ${maxDD}%`,
    `     Scanner: { ${scannerStr} }`,
    `     PM: SL=${slPct}%  TP=${tpPct}%  Hold=${holdH}h`,
  ].join('\n');
}

function buildExportEntry(rc: RankedCandidate) {
  const c = rc.candidate;
  const r = rc.lastStageResult;
  return {
    rank: rc.rank,
    candidateId: c.id,
    templateName: c.templateName,
    scannerParams: c.scannerParams,
    pmParams: c.pmParams,
    performance: {
      totalPnl: r.totalPnl,
      totalTrades: r.totalTrades,
      profitableWeeks: r.profitableWeeks,
      totalWeeks: r.totalWeeks,
      avgProfitFactor: r.avgProfitFactor,
      avgSharpe: r.avgSharpe,
      maxDrawdown: r.maxDrawdown,
    },
  };
}

// ─── Commands ──────────────────────────────────────────────────────

function listTournaments(dbPath: string): void {
  const { tournaments: store, close } = createStorage(dbPath);
  const ids = store.list();
  close();

  if (ids.length === 0) {
    console.log('No tournaments found.');
    return;
  }

  console.log(`Found ${String(ids.length)} tournament(s):\n`);
  for (const id of ids) {
    // Extract timestamp from ID: "tournament-1711748400000"
    const tsMatch = id.match(/(\d{13})$/);
    const dateStr = tsMatch ? new Date(Number(tsMatch[1])).toISOString() : 'unknown';
    console.log(`  ${id}  (${dateStr})`);
  }
}

/** Reinterpret unknown JSON as typed value without `as` assertion. */
function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

function loadState(store: { tournaments: { load: (id: string) => unknown }; close: () => void }, id: string): TournamentState {
  const raw = store.tournaments.load(id);
  store.close();
  if (!raw) {
    console.error(`Tournament not found: ${id}`);
    process.exit(1);
  }
  return unsafeCast<TournamentState>(raw);
}

function showTop(state: TournamentState, n: number): void {
  const rankings = getFinalRankings(state);

  if (rankings.length === 0) {
    console.log('No survivors found (tournament may not have completed).');
    return;
  }

  const display = rankings.slice(0, n);
  console.log(`=== Top ${String(display.length)} of ${String(rankings.length)} survivors ===`);
  console.log(`Tournament started: ${new Date(state.startedAt).toISOString()}`);
  console.log(`Completed stages: ${String(state.completedStages)}/${String(state.config.stages.length)}`);
  console.log('');

  for (const rc of display) {
    console.log(formatCandidate(rc));
    console.log('');
  }
}

function showByTemplate(state: TournamentState): void {
  const rankings = getFinalRankings(state);

  if (rankings.length === 0) {
    console.log('No survivors found.');
    return;
  }

  // Group by template, pick best per template
  const byTemplate = new Map<string, RankedCandidate>();
  for (const rc of rankings) {
    const name = rc.candidate.templateName;
    if (!byTemplate.has(name)) {
      byTemplate.set(name, rc);
    }
  }

  // Also show templates with zero survivors
  const allTemplates = new Set(state.candidates.map((c) => c.templateName));

  console.log(`=== Best candidate per template ===`);
  console.log(`Tournament started: ${new Date(state.startedAt).toISOString()}`);
  console.log(`Completed stages: ${String(state.completedStages)}/${String(state.config.stages.length)}`);
  console.log('');

  for (const name of allTemplates) {
    const best = byTemplate.get(name);
    if (best) {
      console.log(`[${name}]`);
      console.log(formatCandidate(best));
    } else {
      console.log(`[${name}]`);
      console.log('  (no survivors)');
    }
    console.log('');
  }
}

async function exportResults(state: TournamentState, path: string, n: number): Promise<void> {
  const rankings = getFinalRankings(state);
  const top = rankings.slice(0, n);

  // Also build best-per-template
  const byTemplate = new Map<string, RankedCandidate>();
  for (const rc of rankings) {
    const name = rc.candidate.templateName;
    if (!byTemplate.has(name)) {
      byTemplate.set(name, rc);
    }
  }

  const output = {
    exportedAt: new Date().toISOString(),
    tournamentStartedAt: new Date(state.startedAt).toISOString(),
    completedStages: state.completedStages,
    totalSurvivors: rankings.length,
    topN: top.map(buildExportEntry),
    bestPerTemplate: Object.fromEntries(
      [...byTemplate.entries()].map(([name, rc]) => [name, buildExportEntry(rc)]),
    ),
  };

  await Bun.write(path, JSON.stringify(output, null, 2) + '\n');
  console.log(`Exported ${String(top.length)} winners + ${String(byTemplate.size)} best-per-template to ${path}`);
}

// ─── Entry Point ───────────────────────────────────────────────────

export async function runResults(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.list) {
    listTournaments(args.dbPath);
    return;
  }

  if (!args.id) {
    // Default: load the most recent tournament
    const { tournaments: store, close } = createStorage(args.dbPath);
    const ids = store.list();
    close();

    if (ids.length === 0) {
      console.log('No tournaments found. Run one first:');
      console.log('  bun run packages/runner/src/cli.ts tournament');
      return;
    }
    args.id = ids[0]!;
    console.log(`Using most recent tournament: ${args.id}\n`);
  }

  const storage = createStorage(args.dbPath);
  const state = loadState(storage, args.id);

  if (args.exportPath) {
    await exportResults(state, args.exportPath, args.top);
    return;
  }

  if (args.byTemplate) {
    showByTemplate(state);
    return;
  }

  showTop(state, args.top);
}
