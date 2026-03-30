#!/usr/bin/env bun
/**
 * CLI entry point for the runner package.
 *
 * Usage:
 *   bun run packages/runner/src/cli.ts tournament
 *   bun run packages/runner/src/cli.ts sync
 */
import { toSymbol } from '@trading-bot/types';
import type { Timeframe, TournamentConfig } from '@trading-bot/types';
import { createStorage, syncCandles } from '@trading-bot/storage';
import { TEMPLATES } from '@trading-bot/strategies';

import { runTournament } from './tournament';
import { createBinanceFetcher } from './fetch-binance';
import { runTestnet } from './testnet';
import { runResults } from './tournament-results';

const command = process.argv[2]; // 'tournament' | 'sync' | 'testnet'

async function tournament(): Promise<void> {
  const dbPath = './data/candles.db';
  const { candles: store, tournaments: tournamentStore } = createStorage(dbPath);
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
    templates: [...TEMPLATES],
    candidatesPerTemplate: 50,
    pmParams: {
      stopLossPct: { min: 1, max: 5, step: 0.5 },
      takeProfitPct: { min: 2, max: 10, step: 0.5 },
      maxHoldTimeHours: { min: 1, max: 24, step: 1 },
    },
    pmSamples: 5,
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
      { weeks: 1, symbols: 1, killRate: 0.25 },
      { weeks: 2, symbols: 2, killRate: 0.50 },
      { weeks: 4, symbols: 3, killRate: 0.50 },
      { weeks: 8, symbols: 4, killRate: 0.50 },
    ],
  };

  console.log('=== Evolutionary Discovery Tournament ===');
  console.log(`Templates: ${config.templates.map((t) => t.name).join(', ')}`);
  console.log(`Candidates: ${String(config.candidatesPerTemplate)} scanner x ${String(config.pmSamples)} PM = ${String(config.candidatesPerTemplate * config.pmSamples)} per template`);
  console.log(`Total: ${String(config.candidatesPerTemplate * config.pmSamples * config.templates.length)} candidates`);
  console.log(`Stages: ${config.stages.map((s) => `${String(s.weeks)}w x ${String(s.symbols)}s kill${String(s.killRate * 100)}%`).join(' -> ')}`);
  console.log(`Timeframe: ${config.timeframe}`);
  console.log(`Data: ${new Date(dataStart).toISOString().slice(0, 10)} -> ${new Date(dataEnd).toISOString().slice(0, 10)}`);

  const tournamentId = `tournament-${Date.now()}`;
  await runTournament(config, tournamentStore, tournamentId, dbPath);
  console.log(`Tournament state saved as: ${tournamentId}`);
}

async function sync(): Promise<void> {
  const dbPath = './data/candles.db';
  const symbols = [
    toSymbol('BTCUSDT'),
    toSymbol('ETHUSDT'),
    toSymbol('SOLUSDT'),
    toSymbol('BNBUSDT'),
  ];
  const timeframes: Timeframe[] = ['1m', '5m', '15m', '1h'];
  const lookbackMs = 90 * 24 * 60 * 60 * 1000;

  const endTime = Date.now();
  const startTime = endTime - lookbackMs;

  console.log(`Syncing candles to ${dbPath}`);
  console.log(`Period: ${new Date(startTime).toISOString()} -> ${new Date(endTime).toISOString()}`);
  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Timeframes: ${timeframes.join(', ')}`);
  console.log('');

  const { candles: store } = createStorage(dbPath);
  const fetcher = createBinanceFetcher();

  const requests = symbols.flatMap((symbol) =>
    timeframes.map((timeframe) => ({
      symbol,
      timeframe,
      startTime,
      endTime,
    })),
  );

  console.log(`${String(requests.length)} sync requests (${String(symbols.length)} symbols x ${String(timeframes.length)} timeframes)`);
  console.log('');

  const results = await syncCandles(store, fetcher, requests);

  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${String(r.symbol)} ${r.timeframe}: up to date (skipped)`);
    } else {
      console.log(`  ${String(r.symbol)} ${r.timeframe}: fetched ${String(r.fetchedCandles)} candles`);
    }
  }

  const totalFetched = results.reduce((sum, r) => sum + r.fetchedCandles, 0);
  console.log('');
  console.log(`Done. ${String(totalFetched)} candles fetched total.`);
}

async function main(): Promise<void> {
  if (command === 'tournament') {
    await tournament();
  } else if (command === 'sync') {
    await sync();
  } else if (command === 'testnet') {
    await runTestnet(process.argv.slice(3));
  } else if (command === 'results') {
    await runResults(process.argv.slice(3));
  } else {
    console.error(`Unknown command: ${String(command)}`);
    console.error('Usage: bun run packages/runner/src/cli.ts <command> [options]');
    console.error('');
    console.error('Commands:');
    console.error('  tournament  Run evolutionary discovery tournament');
    console.error('  sync        Sync candle data from Binance');
    console.error('  testnet     Run LiveRunner against Binance futures testnet');
    console.error('  results     View and export tournament results');
    console.error('');
    console.error('Results options:');
    console.error('  --list                     List all past tournaments');
    console.error('  --id <tournament-id>       Select tournament (default: most recent)');
    console.error('  --top <N>                  Show top N winners (default: 10)');
    console.error('  --by-template              Show best candidate per template');
    console.error('  --export <path.json>       Export winning configs as JSON');
    console.error('');
    console.error('Testnet options:');
    console.error('  --symbol BTCUSDT           Symbol to trade (default: BTCUSDT)');
    console.error('  --timeframe 5m             Candle timeframe (default: 5m)');
    console.error('  --duration 3600000         Run duration in ms (default: 1 hour)');
    console.error('  --template ema-crossover   Scanner template (default: ema-crossover)');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Command '${String(command)}' failed:`, err);
  process.exit(1);
});
