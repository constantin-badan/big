/**
 * Evolutionary discovery tournament.
 *
 * Generates N strategy candidates from scanner templates, then progressively
 * eliminates weak performers through increasingly difficult stages:
 *   Stage 1: 1 week x 1 coin -> kill bottom 25%
 *   Stage 2: 2 weeks x 2 coins -> kill bottom 50%
 *   Stage 3: 4 weeks x 4 coins -> kill bottom 50%
 *   Stage 4: 8 weeks x all coins -> kill bottom 50%
 *
 * Each stage uses different random coins and time periods.
 * Risk config is fixed — only scanner params and PM params are swept.
 */
import type {
  BacktestConfig,
  CandidateStageResult,
  ExchangeConfig,
  ParamBounds,
  PositionManagerConfig,
  RiskConfig,
  ScannerTemplate,
  Symbol,
  Timeframe,
  TournamentCandidate,
  TournamentConfig,
  TournamentStageConfig,
  TournamentState,
} from '@trading-bot/types';
import { createStorage } from '@trading-bot/storage';
import type { ICandleStore, ITournamentStore } from '@trading-bot/storage';
import { createBacktestEngine } from '@trading-bot/backtest-engine';

import { classifyWeeks, selectStratifiedWeeks } from './regime-detection';

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};

/** 100 candles warmup — enough for indicators, doesn't eat into 1-week periods. */
function computeWarmupMs(timeframes: Timeframe[]): number {
  const maxTfMs = Math.max(...timeframes.map((tf) => TIMEFRAME_MS[tf]));
  return 100 * maxTfMs;
}
import { fetchTopSymbols } from './fetch-top-symbols';
import { createPrng } from './prng';

// ─── Param Generation ───────────────────────────────────────────────

function sampleFromBounds(bounds: ParamBounds, count: number, random: () => number): Array<Record<string, number>> {
  const keys = Object.keys(bounds);
  const samples: Array<Record<string, number>> = [];

  for (let i = 0; i < count; i++) {
    const sample: Record<string, number> = {};
    for (const key of keys) {
      const spec = bounds[key]!;
      const range = spec.max - spec.min;
      let value = spec.min + random() * range;
      if (spec.step !== undefined && spec.step > 0) {
        value = spec.min + Math.round((value - spec.min) / spec.step) * spec.step;
        value = Math.max(spec.min, Math.min(spec.max, value));
      }
      sample[key] = value;
    }
    samples.push(sample);
  }
  return samples;
}

function generateCandidates(
  templates: ScannerTemplate[],
  candidatesPerTemplate: number,
  pmBounds: ParamBounds,
  pmSamples: number,
  random: () => number,
): TournamentCandidate[] {
  const candidates: TournamentCandidate[] = [];
  let idCounter = 0;

  for (const template of templates) {
    const scannerParamSets = sampleFromBounds(template.params, candidatesPerTemplate, random);
    const pmParamSets = sampleFromBounds(pmBounds, pmSamples, random);

    for (const scannerParams of scannerParamSets) {
      // Skip invalid combinations via template constraint
      if (template.isValid !== undefined && !template.isValid(scannerParams)) continue;

      for (const pmParams of pmParamSets) {
        idCounter += 1;
        candidates.push({
          id: `${template.name}-${String(idCounter)}`,
          templateName: template.name,
          scannerParams,
          pmParams,
        });
      }
    }
  }

  return candidates;
}

// ─── Random Selection ──────────────────────────────────────────────

function selectRandomSymbols(pool: Symbol[], count: number, random: () => number): Symbol[] {
  const shuffled = [...pool];
  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = temp;
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// ─── Stage Execution ────────────────────────────────────────────────

async function runStage(
  stageIndex: number,
  stageConfig: TournamentStageConfig,
  candidates: TournamentCandidate[],
  templates: Map<string, ScannerTemplate>,
  symbols: Symbol[],
  weeks: Array<{ startTime: number; endTime: number }>,
  timeframe: Timeframe,
  riskConfig: RiskConfig,
  exchangeConfig: ExchangeConfig,
  store: ICandleStore,
): Promise<CandidateStageResult[]> {
  const results: CandidateStageResult[] = [];

  for (const candidate of candidates) {
    const template = templates.get(candidate.templateName);
    if (!template) throw new Error(`Unknown template: ${candidate.templateName}`);

    // Build PM config from candidate's PM params
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

    const factory = template.createFactory(symbols, timeframe, riskConfig, pmConfig);

    let totalPnl = 0;
    let totalTrades = 0;
    let profitableWeeks = 0;
    let pfSum = 0;
    let sharpeSum = 0;
    let worstDrawdown = 0;

    const loader = (sym: Symbol, tf: Timeframe, start: number, end: number) =>
      Promise.resolve(store.getCandles(sym, tf, start, end));

    for (const week of weeks) {
      // Include any additional timeframes the template requires (e.g., 4h trend filter)
      const extraTimeframes = template.requiredTimeframes ?? [];
      const allTimeframes = [timeframe, ...extraTimeframes.filter((tf) => tf !== timeframe)];

      const btConfig: BacktestConfig = {
        startTime: week.startTime,
        endTime: week.endTime,
        symbols,
        timeframes: allTimeframes,
        warmupMs: computeWarmupMs(allTimeframes),
      };

      const engine = createBacktestEngine(loader, exchangeConfig);
      const result = await engine.run(factory, candidate.scannerParams, btConfig);

      const weekPnl = result.finalBalance - result.initialBalance;
      totalPnl += weekPnl;
      totalTrades += result.metrics.totalTrades;
      if (weekPnl > 0) profitableWeeks += 1;
      pfSum += Math.min(result.metrics.profitFactor, 100);
      sharpeSum += result.metrics.sharpeRatio;
      if (result.metrics.maxDrawdown > worstDrawdown) {
        worstDrawdown = result.metrics.maxDrawdown;
      }
    }

    results.push({
      candidateId: candidate.id,
      stageIndex,
      totalPnl,
      totalTrades,
      profitableWeeks,
      totalWeeks: weeks.length,
      avgProfitFactor: pfSum / weeks.length,
      avgSharpe: sharpeSum / weeks.length,
      maxDrawdown: worstDrawdown,
      survived: false, // set after ranking
    });
  }

  // Rank by total PnL. Zero-trade candidates rank at 0 PnL (neutral).
  // They survive if within the keep threshold — some strategies legitimately
  // produce few trades on a single coin/week.
  results.sort((a, b) => b.totalPnl - a.totalPnl);
  const killCount = Math.floor(results.length * stageConfig.killRate);
  const surviveCount = results.length - killCount;

  for (let i = 0; i < results.length; i++) {
    results[i]!.survived = i < surviveCount;
  }

  return results;
}

// ─── Tournament Runner ──────────────────────────────────────────────

export async function runTournament(
  config: TournamentConfig,
  tournamentStore: ITournamentStore,
  tournamentId: string,
  dbPath = './data/candles.db',
): Promise<TournamentState> {
  // Resolve symbol pool — fetch dynamically if not provided
  const symbolPool =
    config.symbolPool && config.symbolPool.length > 0
      ? config.symbolPool
      : await fetchTopSymbols(50);

  const seed = config.seed ?? Date.now();
  const random = createPrng(seed);

  console.log(`Symbol pool: ${String(symbolPool.length)} symbols`);
  console.log(`Seed: ${String(seed)}`);

  const templateMap = new Map<string, ScannerTemplate>();
  for (const t of config.templates) {
    templateMap.set(t.name, t);
  }

  // Generate all candidates
  const candidates = generateCandidates(
    config.templates,
    config.candidatesPerTemplate,
    config.pmParams,
    config.pmSamples,
    random,
  );

  console.log(`Generated ${String(candidates.length)} candidates`);

  const state: TournamentState = {
    config,
    currentStage: 0,
    candidates,
    stageResults: [],
    stageSymbols: [],
    stageWeeks: [],
    startedAt: Date.now(),
    completedStages: 0,
  };

  let activeCandidates = [...candidates];

  for (let s = 0; s < config.stages.length; s++) {
    const stageConfig = config.stages[s]!;

    if (activeCandidates.length <= 1) {
      console.log(`Only ${String(activeCandidates.length)} candidate(s) left, stopping early.`);
      break;
    }

    // Select random symbols (deterministic via seeded PRNG)
    const symbols = selectRandomSymbols(symbolPool, stageConfig.symbols, random);

    // Select weeks with stratified regime diversity
    const store = createStorage(dbPath).candles;
    const allWeeks = classifyWeeks(
      store,
      symbols[0]!,
      config.timeframe,
      config.dataRange.startTime,
      config.dataRange.endTime,
    );
    const selectedWeeks = selectStratifiedWeeks(allWeeks, stageConfig.weeks, random);
    const weeks = selectedWeeks.map((w) => ({ startTime: w.startTime, endTime: w.endTime }));
    const regimes = selectedWeeks.map((w) => w.regime);

    state.stageSymbols.push(symbols);
    state.stageWeeks.push(weeks);
    state.currentStage = s;

    console.log('');
    console.log(`=== Stage ${String(s + 1)}/${String(config.stages.length)} ===`);
    console.log(`  Candidates: ${String(activeCandidates.length)}`);
    console.log(`  Symbols: ${symbols.join(', ')}`);
    console.log(`  Weeks: ${weeks.map((w, i) => `${new Date(w.startTime).toISOString().slice(0, 10)}[${String(regimes[i] ?? '?')}]`).join(', ')}`);
    console.log(`  Kill rate: ${String(stageConfig.killRate * 100)}%`);

    const stageStart = Date.now();
    const results = await runStage(
      s,
      stageConfig,
      activeCandidates,
      templateMap,
      symbols,
      weeks,
      config.timeframe,
      config.riskConfig,
      config.exchangeConfig,
      createStorage(dbPath).candles,
    );
    const stageMs = Date.now() - stageStart;

    state.stageResults.push(...results);
    state.completedStages = s + 1;

    // Persist state after each stage for resume capability
    tournamentStore.save(tournamentId, state);

    // Filter to survivors
    const survivorIds = new Set(
      results.filter((r) => r.survived).map((r) => r.candidateId),
    );
    const killed = activeCandidates.length - survivorIds.size;
    activeCandidates = activeCandidates.filter((c) => survivorIds.has(c.id));

    // Print stage summary
    const topResults = results.filter((r) => r.survived).slice(0, 5);
    console.log(`  Completed in ${String(stageMs)}ms`);
    console.log(`  Killed: ${String(killed)}, Survived: ${String(activeCandidates.length)}`);
    console.log('  Top 5 survivors:');
    for (const r of topResults) {
      const c = candidates.find((x) => x.id === r.candidateId)!;
      const scannerStr = Object.entries(c.scannerParams)
        .map(([k, v]) => `${k}=${String(Math.round(v))}`)
        .join(',');
      let pmStr = `SL=${String(c.pmParams.stopLossPct?.toFixed(1))}% TP=${String(c.pmParams.takeProfitPct?.toFixed(1))}%`;
      if (c.pmParams.trailingActivationPct) pmStr += ` trail=${String(c.pmParams.trailingActivationPct.toFixed(1))}%`;
      if (c.pmParams.breakevenPct) pmStr += ` BE=${String(c.pmParams.breakevenPct.toFixed(1))}%`;
      console.log(
        `    ${c.id}: ${scannerStr} ${pmStr} | PnL=${r.totalPnl.toFixed(2)} trades=${String(r.totalTrades)} weeks=${String(r.profitableWeeks)}/${String(r.totalWeeks)}`,
      );
    }
  }

  // Final results
  console.log('');
  console.log('=== TOURNAMENT COMPLETE ===');
  console.log(`Survivors: ${String(activeCandidates.length)}`);
  console.log(`Total time: ${String(Date.now() - state.startedAt)}ms`);
  console.log('');

  if (activeCandidates.length > 0) {
    console.log('Final rankings:');
    // Get last stage results for survivors
    const lastStage = state.completedStages - 1;
    const lastResults = state.stageResults
      .filter((r) => r.stageIndex === lastStage && r.survived)
      .sort((a, b) => b.totalPnl - a.totalPnl);

    for (let i = 0; i < lastResults.length; i++) {
      const r = lastResults[i]!;
      const c = candidates.find((x) => x.id === r.candidateId)!;
      console.log(
        `  #${String(i + 1)} ${c.id}: PnL=${r.totalPnl.toFixed(2)} trades=${String(r.totalTrades)} profWeeks=${String(r.profitableWeeks)}/${String(r.totalWeeks)} avgPF=${r.avgProfitFactor.toFixed(2)} maxDD=${r.maxDrawdown.toFixed(1)}%`,
      );
      console.log(
        `       scanner: ${JSON.stringify(c.scannerParams)}`,
      );
      console.log(
        `       pm: SL=${String(c.pmParams.stopLossPct?.toFixed(1))}% TP=${String(c.pmParams.takeProfitPct?.toFixed(1))}% hold=${String(c.pmParams.maxHoldTimeHours?.toFixed(0))}h`,
      );
    }
  }

  return state;
}
