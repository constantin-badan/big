import { createStorage, syncCandles } from '@trading-bot/storage';
import { TEMPLATES } from '@trading-bot/strategies';
/**
 * Grind: automated tournament loop with cumulative loser blacklist.
 *
 * Each iteration:
 *   1. Load blacklist (candidateIds that always lose)
 *   2. Run tournament with all templates
 *   3. Collect bottom 5% performers
 *   4. Add them to the blacklist
 *   5. Repeat
 *
 * The blacklist grows over time, making each run faster.
 * Survivors across multiple runs are genuinely robust.
 *
 * Usage:
 *   bun run packages/runner/src/cli.ts grind [--rounds 10]
 */
import type {
  TournamentConfig,
  Timeframe,
  TournamentState,
  TournamentCandidate,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { createBinanceFetcher } from './fetch-binance';
import { fetchTopSymbols } from './fetch-top-symbols';
import { loadBounds, saveBounds, narrowBounds } from './adaptive-bounds';
import { runTournament } from './tournament';

const DB_PATH = './data/candles.db';
const BLACKLIST_PATH = './grind-blacklist.json';

function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

const BLACKLIST_THRESHOLD = 2;

// Compact format: { "hash": count, "hash": count, ... }
// Hash = paramsKey. Count = how many rounds in bottom 5%.
type BlacklistData = Record<string, number>;

function paramsKey(
  templateName: string,
  scanner: Record<string, number>,
  pm: Record<string, number>,
): string {
  const s = Object.entries(scanner)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(Math.round(v * 100))}`)
    .join(',');
  const p = Object.entries(pm)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(Math.round(v * 100))}`)
    .join(',');
  return `${templateName}:${s}|${p}`;
}

async function loadBlacklist(): Promise<{ data: BlacklistData; activeKeys: Set<string> }> {
  try {
    const raw = await Bun.file(BLACKLIST_PATH).text();
    const data = unsafeCast<BlacklistData>(JSON.parse(raw));
    const activeKeys = new Set<string>();
    for (const [key, count] of Object.entries(data)) {
      if (count >= BLACKLIST_THRESHOLD) activeKeys.add(key);
    }
    return { data, activeKeys };
  } catch {
    return { data: {}, activeKeys: new Set() };
  }
}

async function saveBlacklist(data: BlacklistData): Promise<void> {
  await Bun.write(BLACKLIST_PATH, JSON.stringify(data) + '\n');
  await Bun.spawn(['npx', 'oxfmt', '--write', BLACKLIST_PATH]).exited;
}

function getBottom5Percent(state: TournamentState): TournamentCandidate[] {
  // Find candidates with worst cumulative PnL across all stages
  const pnlByCandidateId = new Map<string, number>();
  for (const r of state.stageResults) {
    const prev = pnlByCandidateId.get(r.candidateId) ?? 0;
    pnlByCandidateId.set(r.candidateId, prev + r.totalPnl);
  }

  const candidateMap = new Map<string, TournamentCandidate>();
  for (const c of state.candidates) {
    candidateMap.set(c.id, c);
  }

  // Sort by cumulative PnL ascending (worst first)
  const sorted = [...pnlByCandidateId.entries()].sort((a, b) => a[1] - b[1]);
  const cutoff = Math.ceil(sorted.length * 0.25);
  const bottom = sorted.slice(0, cutoff);

  const losers: TournamentCandidate[] = [];
  for (const [id] of bottom) {
    const c = candidateMap.get(id);
    if (c) losers.push(c);
  }
  return losers;
}

export async function runGrind(argv: string[]): Promise<void> {
  let rounds = 10;
  let maxConfigs = 0; // 0 = no limit
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rounds' && argv[i + 1]) rounds = Number(argv[++i]);
    if (argv[i] === '--max-configs' && argv[i + 1]) maxConfigs = Number(argv[++i]);
  }

  console.log(
    `=== GRIND MODE: ${String(rounds)} rounds${maxConfigs > 0 ? `, max ${String(maxConfigs)} configs` : ''} ===\n`,
  );

  const timeframe: Timeframe = '5m';
  const refSymbol = toSymbol('BTCUSDT');
  const fetcher = createBinanceFetcher();

  // Ensure reference data
  const { candles: refStore, tournaments: tournamentStore } = createStorage(DB_PATH);
  const lookback = 90 * 24 * 60 * 60 * 1000;
  await syncCandles(refStore, fetcher, [
    {
      symbol: refSymbol,
      timeframe,
      startTime: Date.now() - lookback,
      endTime: Date.now(),
    },
  ]);
  const dataStart = refStore.getEarliestTimestamp(refSymbol, timeframe)!;
  const dataEnd = refStore.getLatestTimestamp(refSymbol, timeframe)!;

  // Fetch symbol pool once
  console.log('Fetching symbols...');
  const symbols = await fetchTopSymbols(150);
  console.log(`Pool: ${String(symbols.length)} symbols\n`);

  for (let round = 1; round <= rounds; round++) {
    const blacklist = await loadBlacklist();
    const bounds = await loadBounds();
    const pmBoundsStr = Object.entries(bounds.pmParams)
      .filter(([k]) => k !== 'maxHoldTimeHours')
      .map(([k, v]) => `${k}=[${String(v.min)}-${String(v.max)}]`)
      .join(' ');
    console.log(
      `\n=== Round ${String(round)}/${String(rounds)} | Blacklisted: ${String(blacklist.activeKeys.size)} | Bounds narrowed ${String(bounds.roundsAnalyzed)}x ===`,
    );
    console.log(`  PM: ${pmBoundsStr}\n`);

    // Compute candidates per template based on max-configs limit
    const templateCount = TEMPLATES.length;
    let scannerSamples = 200;
    let pmSamples = 20;
    if (maxConfigs > 0) {
      // target = scannerSamples * pmSamples * templateCount <= maxConfigs
      const perTemplate = Math.floor(maxConfigs / templateCount);
      pmSamples = Math.min(20, Math.max(1, Math.floor(Math.sqrt(perTemplate))));
      scannerSamples = Math.min(200, Math.max(1, Math.floor(perTemplate / pmSamples)));
    }

    const config: TournamentConfig = {
      templates: [...TEMPLATES],
      candidatesPerTemplate: scannerSamples,
      pmParams: bounds.pmParams,
      pmSamples,
      riskConfig: {
        maxPositionSizePct: 5,
        maxConcurrentPositions: 2,
        maxDailyLossPct: 3,
        maxDrawdownPct: 15,
        maxDailyTrades: 50,
        cooldownAfterLossMs: 300_000,
        leverage: 1,
        initialBalance: 10_000,
      },
      exchangeConfig: {
        type: 'backtest-sim',
        feeStructure: { maker: 0.0002, taker: 0.0004 },
        slippageModel: { type: 'fixed', fixedBps: 5 },
        initialBalance: 10_000,
      },
      timeframe,
      symbolPool: symbols,
      dataRange: { startTime: dataStart, endTime: dataEnd },
      // 5 quick stages — enough to identify losers for blacklist.
      // Full 20-stage tournament is for the final 'tournament' command.
      stages: [
        { weeks: 1, symbols: 2, killRate: 0.15 },
        { weeks: 1, symbols: 3, killRate: 0.2 },
        { weeks: 1, symbols: 4, killRate: 0.25 },
        { weeks: 1, symbols: 5, killRate: 0.3 },
        { weeks: 1, symbols: 6, killRate: 0.3 },
      ],
      seed: Date.now(),
    };

    const tournamentId = `grind-${String(round)}-${Date.now()}`;
    const state = await runTournament(
      config,
      tournamentStore,
      tournamentId,
      DB_PATH,
      blacklist.activeKeys,
    );

    // Increment bottom count for bottom 5%
    const bottom = getBottom5Percent(state);
    let newlyBlacklisted = 0;
    for (const c of bottom) {
      const key = paramsKey(c.templateName, c.scannerParams, c.pmParams);
      const prev = blacklist.data[key] ?? 0;
      if (prev < BLACKLIST_THRESHOLD) {
        blacklist.data[key] = prev + 1;
        if (prev + 1 === BLACKLIST_THRESHOLD) newlyBlacklisted++;
      }
    }

    const tracked = Object.keys(blacklist.data).length;
    const active = Object.values(blacklist.data).filter((c) => c >= BLACKLIST_THRESHOLD).length;
    await saveBlacklist(blacklist.data);

    // Narrow PM bounds based on winners vs losers
    const newPmBounds = narrowBounds(state, bounds.pmParams);
    await saveBounds({ pmParams: newPmBounds, roundsAnalyzed: bounds.roundsAnalyzed + 1 });

    const survivors = state.stageResults.filter(
      (r) => r.stageIndex === state.completedStages - 1 && r.survived,
    ).length;

    console.log(
      `\nRound ${String(round)} done: ${String(survivors)} survivors, +${String(newlyBlacklisted)} newly blacklisted (tracked: ${String(tracked)}, active: ${String(active)})`,
    );
  }

  console.log('\n=== GRIND COMPLETE ===');
  const final = await loadBlacklist();
  const counts = Object.values(final.data);
  const strike1 = counts.filter((c) => c === 1).length;
  const strike2 = counts.filter((c) => c === BLACKLIST_THRESHOLD).length;
  const blacklisted = counts.filter((c) => c >= BLACKLIST_THRESHOLD).length;
  console.log(
    `Tracked: ${String(counts.length)} | 1 strike: ${String(strike1)} | 2 strikes: ${String(strike2)} | Blacklisted: ${String(blacklisted)}`,
  );
}
