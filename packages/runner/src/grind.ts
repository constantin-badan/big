/**
 * Grind: automated tournament loop with adaptive bounds narrowing.
 *
 * Each iteration:
 *   1. Load adaptive PM bounds (narrows over time)
 *   2. Run 5-stage quick tournament with random coins
 *   3. Analyze top 25% winners, narrow bounds toward their IQR
 *   4. Save narrowed bounds, repeat
 *
 * Usage:
 *   bun run packages/runner/src/cli.ts grind [--rounds 10] [--max-configs 5000]
 */
import type { TournamentConfig, Timeframe, ParamBounds } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';
import { createStorage, syncCandles } from '@trading-bot/storage';
import { TEMPLATES } from '@trading-bot/strategies';

import { createBinanceFetcher } from './fetch-binance';
import { fetchTopSymbols } from './fetch-top-symbols';
import { loadBounds, saveBounds, narrowBounds } from './adaptive-bounds';
import { runTournament } from './tournament';

const DB_PATH = './data/candles.db';

function countPossibleConfigs(pmBounds: ParamBounds): number {
  let pmCombos = 1;
  for (const spec of Object.values(pmBounds)) {
    const step = spec.step ?? 1;
    const steps = Math.max(1, Math.floor((spec.max - spec.min) / step) + 1);
    pmCombos *= steps;
  }
  let scannerCombos = 0;
  for (const t of TEMPLATES) {
    let combos = 1;
    for (const spec of Object.values(t.params)) {
      const step = spec.step ?? 1;
      const steps = Math.max(1, Math.floor((spec.max - spec.min) / step) + 1);
      combos *= steps;
    }
    scannerCombos += combos;
  }
  return scannerCombos * pmCombos;
}

export async function runGrind(argv: string[]): Promise<void> {
  let rounds = 10;
  let maxConfigs = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rounds' && argv[i + 1]) rounds = Number(argv[++i]);
    if (argv[i] === '--max-configs' && argv[i + 1]) maxConfigs = Number(argv[++i]);
  }

  console.log(`=== GRIND MODE: ${String(rounds)} rounds${maxConfigs > 0 ? `, max ${String(maxConfigs)} configs` : ''} ===\n`);

  const timeframe: Timeframe = '5m';
  const refSymbol = toSymbol('BTCUSDT');
  const fetcher = createBinanceFetcher();

  const { candles: refStore, tournaments: tournamentStore } = createStorage(DB_PATH);
  const lookback = 90 * 24 * 60 * 60 * 1000;
  await syncCandles(refStore, fetcher, [{
    symbol: refSymbol, timeframe,
    startTime: Date.now() - lookback, endTime: Date.now(),
  }]);
  const dataStart = refStore.getEarliestTimestamp(refSymbol, timeframe)!;
  const dataEnd = refStore.getLatestTimestamp(refSymbol, timeframe)!;

  console.log('Fetching symbols...');
  const symbols = await fetchTopSymbols(150);
  console.log(`Pool: ${String(symbols.length)} symbols\n`);

  for (let round = 1; round <= rounds; round++) {
    const bounds = await loadBounds();
    const configsBefore = countPossibleConfigs(bounds.pmParams);
    const pmStr = Object.entries(bounds.pmParams)
      .filter(([k]) => k !== 'maxHoldTimeHours')
      .map(([k, v]) => `${k}=[${String(v.min)}-${String(v.max)}]`)
      .join(' ');
    console.log(`\n=== Round ${String(round)}/${String(rounds)} | Search space: ${configsBefore.toLocaleString()} configs | Narrowed ${String(bounds.roundsAnalyzed)}x ===`);
    console.log(`  PM: ${pmStr}\n`);

    const templateCount = TEMPLATES.length;
    let scannerSamples = 200;
    let pmSamples = 20;
    if (maxConfigs > 0) {
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
      stages: [
        { weeks: 1, symbols: 2, killRate: 0.15 },
        { weeks: 1, symbols: 3, killRate: 0.20 },
        { weeks: 1, symbols: 4, killRate: 0.25 },
        { weeks: 1, symbols: 5, killRate: 0.30 },
        { weeks: 1, symbols: 6, killRate: 0.30 },
      ],
      seed: Date.now(),
    };

    const tournamentId = `grind-${String(round)}-${Date.now()}`;
    const state = await runTournament(config, tournamentStore, tournamentId, DB_PATH);

    // Narrow PM bounds based on winners
    const newPmBounds = narrowBounds(state, bounds.pmParams);
    const configsAfter = countPossibleConfigs(newPmBounds);
    await saveBounds({ pmParams: newPmBounds, roundsAnalyzed: bounds.roundsAnalyzed + 1 });

    const survivors = state.stageResults.filter(
      (r) => r.stageIndex === state.completedStages - 1 && r.survived,
    ).length;

    const reduction = configsBefore > 0 ? ((1 - configsAfter / configsBefore) * 100).toFixed(1) : '0';
    console.log(`\nRound ${String(round)} done: ${String(survivors)} survivors | Search space: ${configsBefore.toLocaleString()} → ${configsAfter.toLocaleString()} (-${reduction}%)`);
  }

  console.log('\n=== GRIND COMPLETE ===');
  const finalBounds = await loadBounds();
  const finalConfigs = countPossibleConfigs(finalBounds.pmParams);
  console.log(`Final search space: ${finalConfigs.toLocaleString()} configs (narrowed ${String(finalBounds.roundsAnalyzed)} times)`);
  const pmSummary = Object.entries(finalBounds.pmParams)
    .filter(([k]) => k !== 'maxHoldTimeHours')
    .map(([k, v]) => `  ${k}: [${String(v.min)} - ${String(v.max)}]`)
    .join('\n');
  console.log('PM bounds:\n' + pmSummary);
}
