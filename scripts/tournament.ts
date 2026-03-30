#!/usr/bin/env bun
/**
 * Thin wrapper — delegates to @trading-bot/runner CLI.
 * Usage: bun run scripts/tournament.ts
 */
import { toSymbol } from '@trading-bot/types';
import type { Timeframe, TournamentConfig } from '@trading-bot/types';
import { createStorage, syncCandles } from '@trading-bot/storage';
import { TEMPLATES } from '@trading-bot/strategies';
import { runTournament, createBinanceFetcher } from '@trading-bot/runner';

const dbPath = './data/candles.db';
const { candles: store, tournaments: tournamentStore } = createStorage(dbPath);
const symbols = [
  toSymbol('BTCUSDT'),
  toSymbol('ETHUSDT'),
  toSymbol('SOLUSDT'),
  toSymbol('BNBUSDT'),
];
const timeframe: Timeframe = '5m';

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

const tournamentId = `tournament-${Date.now()}`;
await runTournament(config, tournamentStore, tournamentId, dbPath);
console.log(`Tournament state saved as: ${tournamentId}`);
