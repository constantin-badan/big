#!/usr/bin/env bun
/**
 * Evolutionary discovery tournament.
 *
 * Generates N strategy candidates from scanner templates, then progressively
 * eliminates weak performers through increasingly difficult stages:
 *   Stage 1: 1 week × 1 coin → kill bottom 25%
 *   Stage 2: 2 weeks × 2 coins → kill bottom 50%
 *   Stage 3: 4 weeks × 4 coins → kill bottom 50%
 *   Stage 4: 8 weeks × all coins → kill bottom 50%
 *
 * Each stage uses different random coins and time periods.
 * Risk config is fixed — only scanner params and PM params are swept.
 */
import { toSymbol } from '@trading-bot/types';
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
import { createStorage, syncCandles } from '@trading-bot/storage';
import type { ICandleStore } from '@trading-bot/storage';
import { createBacktestEngine } from '@trading-bot/backtest-engine';

import { createBinanceFetcher } from './fetch-binance';
import { emaCrossover } from '../strategies/ema-crossover';

// ─── Param Generation ───────────────────────────────────────────────

function sampleFromBounds(bounds: ParamBounds, count: number): Array<Record<string, number>> {
  const keys = Object.keys(bounds);
  const samples: Array<Record<string, number>> = [];

  for (let i = 0; i < count; i++) {
    const sample: Record<string, number> = {};
    for (const key of keys) {
      const spec = bounds[key]!;
      const range = spec.max - spec.min;
      let value = spec.min + Math.random() * range;
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
): TournamentCandidate[] {
  const candidates: TournamentCandidate[] = [];
  let idCounter = 0;

  for (const template of templates) {
    const scannerParamSets = sampleFromBounds(template.params, candidatesPerTemplate);
    const pmParamSets = sampleFromBounds(pmBounds, pmSamples);

    for (const scannerParams of scannerParamSets) {
      // Skip invalid combinations (e.g., fastPeriod >= slowPeriod for crossover)
      if (scannerParams.fastPeriod !== undefined && scannerParams.slowPeriod !== undefined) {
        if (scannerParams.fastPeriod >= scannerParams.slowPeriod) continue;
      }

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

// ─── Random Selection (deterministic seed per stage) ────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function selectRandomSymbols(pool: Symbol[], count: number): Symbol[] {
  const shuffled = [...pool];
  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = temp;
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function selectRandomWeeks(
  startTime: number,
  endTime: number,
  count: number,
): Array<{ startTime: number; endTime: number }> {
  const totalRange = endTime - startTime;
  const maxWeeks = Math.floor(totalRange / WEEK_MS);
  const actualCount = Math.min(count, maxWeeks);

  // Divide range into equal slices, pick one week per slice
  const sliceSize = Math.floor(totalRange / actualCount);
  const weeks: Array<{ startTime: number; endTime: number }> = [];

  for (let i = 0; i < actualCount; i++) {
    const sliceStart = startTime + i * sliceSize;
    const maxOffset = sliceSize - WEEK_MS;
    const offset = maxOffset > 0 ? Math.floor(Math.random() * maxOffset) : 0;
    const weekStart = sliceStart + offset;
    weeks.push({ startTime: weekStart, endTime: weekStart + WEEK_MS });
  }

  return weeks;
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
    const pmConfig: PositionManagerConfig = {
      defaultStopLossPct: candidate.pmParams.stopLossPct ?? 2,
      defaultTakeProfitPct: candidate.pmParams.takeProfitPct ?? 4,
      trailingStopEnabled: false,
      trailingStopActivationPct: 0,
      trailingStopDistancePct: 0,
      maxHoldTimeMs: (candidate.pmParams.maxHoldTimeHours ?? 4) * 3_600_000,
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
      const btConfig: BacktestConfig = {
        startTime: week.startTime,
        endTime: week.endTime,
        symbols,
        timeframes: [timeframe],
      };

      const engine = createBacktestEngine(loader, exchangeConfig);
      const result = await engine.run(factory, candidate.scannerParams, btConfig);

      const weekPnl = result.finalBalance - result.initialBalance;
      totalPnl += weekPnl;
      totalTrades += result.metrics.totalTrades;
      if (weekPnl > 0) profitableWeeks += 1;
      pfSum += result.metrics.profitFactor;
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

  // Kill zero-trade candidates regardless of PnL — they survived by not playing
  for (const r of results) {
    if (r.totalTrades === 0) r.totalPnl = -Infinity;
  }

  // Rank by total PnL and mark survivors
  results.sort((a, b) => b.totalPnl - a.totalPnl);
  const killCount = Math.floor(results.length * stageConfig.killRate);
  const surviveCount = results.length - killCount;

  for (let i = 0; i < results.length; i++) {
    // Zero-trade candidates are always killed
    results[i]!.survived = i < surviveCount && results[i]!.totalTrades > 0;
  }

  return results;
}

// ─── Tournament Runner ──────────────────────────────────────────────

async function runTournament(config: TournamentConfig): Promise<TournamentState> {
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

    // Select random symbols and weeks for this stage
    const symbols = selectRandomSymbols(config.symbolPool, stageConfig.symbols);
    const weeks = selectRandomWeeks(
      config.dataRange.startTime,
      config.dataRange.endTime,
      stageConfig.weeks,
    );

    state.stageSymbols.push(symbols);
    state.stageWeeks.push(weeks);
    state.currentStage = s;

    console.log('');
    console.log(`=== Stage ${String(s + 1)}/${String(config.stages.length)} ===`);
    console.log(`  Candidates: ${String(activeCandidates.length)}`);
    console.log(`  Symbols: ${symbols.join(', ')}`);
    console.log(`  Weeks: ${weeks.map((w) => new Date(w.startTime).toISOString().slice(0, 10)).join(', ')}`);
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
      createStorage('./data/candles.db').candles,
    );
    const stageMs = Date.now() - stageStart;

    state.stageResults.push(...results);
    state.completedStages = s + 1;

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
      const pmStr = `SL=${String(c.pmParams.stopLossPct?.toFixed(1))}% TP=${String(c.pmParams.takeProfitPct?.toFixed(1))}%`;
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

// ─── Main: Configure and run ────────────────────────────────────────

async function main(): Promise<void> {
  // Ensure we have data
  const { candles: store } = createStorage('./data/candles.db');
  const symbols = [
    toSymbol('BTCUSDT'),
    toSymbol('ETHUSDT'),
    toSymbol('SOLUSDT'),
    toSymbol('BNBUSDT'),
  ];
  const timeframe: Timeframe = '5m';

  // Check data availability
  const earliest = store.getEarliestTimestamp(symbols[0]!, timeframe);
  const latest = store.getLatestTimestamp(symbols[0]!, timeframe);
  if (earliest === null || latest === null) {
    console.log('No data found. Syncing 90 days...');
    const fetcher = createBinanceFetcher();
    const lookback = 90 * 24 * 60 * 60 * 1000;
    const requests = symbols.flatMap((s) =>
      [timeframe].map((tf) => ({
        symbol: s,
        timeframe: tf,
        startTime: Date.now() - lookback,
        endTime: Date.now(),
      })),
    );
    await syncCandles(store, fetcher, requests);
  }

  const dataStart = store.getEarliestTimestamp(symbols[0]!, timeframe)!;
  const dataEnd = store.getLatestTimestamp(symbols[0]!, timeframe)!;

  const config: TournamentConfig = {
    templates: [emaCrossover],
    candidatesPerTemplate: 50,  // 50 scanner param sets
    pmParams: {
      stopLossPct: { min: 1, max: 5, step: 0.5 },
      takeProfitPct: { min: 2, max: 10, step: 0.5 },
      maxHoldTimeHours: { min: 1, max: 24, step: 1 },
    },
    pmSamples: 5,  // 5 PM configs per scanner config → 250 total candidates
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
    stages: [
      { weeks: 1, symbols: 1, killRate: 0.25 },  // gentle first filter
      { weeks: 2, symbols: 2, killRate: 0.50 },
      { weeks: 4, symbols: 3, killRate: 0.50 },
      { weeks: 8, symbols: 4, killRate: 0.50 },  // final: all coins, 8 weeks
    ],
  };

  console.log('=== Evolutionary Discovery Tournament ===');
  console.log(`Templates: ${config.templates.map((t) => t.name).join(', ')}`);
  console.log(`Candidates: ${String(config.candidatesPerTemplate)} scanner × ${String(config.pmSamples)} PM = ${String(config.candidatesPerTemplate * config.pmSamples)} per template`);
  console.log(`Total: ${String(config.candidatesPerTemplate * config.pmSamples * config.templates.length)} candidates`);
  console.log(`Stages: ${config.stages.map((s) => `${String(s.weeks)}w×${String(s.symbols)}s kill${String(s.killRate * 100)}%`).join(' → ')}`);
  console.log(`Timeframe: ${config.timeframe}`);
  console.log(`Data: ${new Date(dataStart).toISOString().slice(0, 10)} → ${new Date(dataEnd).toISOString().slice(0, 10)}`);

  await runTournament(config);
}

main().catch((err) => {
  console.error('Tournament failed:', err);
  process.exit(1);
});
