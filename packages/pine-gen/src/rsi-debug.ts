#!/usr/bin/env bun
/**
 * RSI debug: computes RSI values on BTCUSDT 5m candles and outputs them
 * in a format that can be compared against TradingView's ta.rsi().
 *
 * Usage:
 *   bun run packages/pine-gen/src/rsi-debug.ts [rsiPeriod] [oversold] [overbought]
 *
 * Dumps: timestamp, close, rsi, prevRsi, longSignal, shortSignal
 * for every candle in the parity period.
 */
import { toSymbol } from '@trading-bot/types';
import type { Symbol, Timeframe, Candle } from '@trading-bot/types';
import { createStorage } from '@trading-bot/storage';

const SYMBOL: Symbol = toSymbol('BTCUSDT');
const TIMEFRAME: Timeframe = '5m';
const DB_PATH = './data/candles.db';

// Same parity window as parity.ts
const TODAY = new Date();
const PARITY_END = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate()));
const PARITY_START = new Date(PARITY_END.getTime() - 4 * 24 * 60 * 60 * 1000);

// 90 days warmup to match parity.ts
const WARMUP_MS = 90 * 24 * 60 * 60 * 1000;

// ─── Wilder's RSI (same as our indicators/src/rsi.ts) ──────────

function computeRsiSeries(candles: Candle[], period: number): Array<{ time: number; close: number; rsi: number | null }> {
  const results: Array<{ time: number; close: number; rsi: number | null }> = [];

  let avgGain: number | null = null;
  let avgLoss: number | null = null;
  const seedGains: number[] = [];
  const seedLosses: number[] = [];
  let prevClose: number | null = null;

  for (const candle of candles) {
    if (prevClose === null) {
      prevClose = candle.close;
      results.push({ time: candle.closeTime, close: candle.close, rsi: null });
      continue;
    }

    const change = candle.close - prevClose;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    prevClose = candle.close;

    if (avgGain === null) {
      // Still seeding
      seedGains.push(gain);
      seedLosses.push(loss);

      if (seedGains.length < period) {
        results.push({ time: candle.closeTime, close: candle.close, rsi: null });
        continue;
      }

      // First RSI: SMA of gains/losses
      let gainSum = 0;
      let lossSum = 0;
      for (let i = 0; i < period; i++) {
        gainSum += seedGains[i]!;
        lossSum += seedLosses[i]!;
      }
      avgGain = gainSum / period;
      avgLoss = lossSum / period;
    } else {
      // Wilder's smoothing
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss! * (period - 1) + loss) / period;
    }

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss!;
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
    results.push({ time: candle.closeTime, close: candle.close, rsi });
  }

  return results;
}

// ─── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rsiPeriod = Number(process.argv[2] ?? 13);
  const oversold = Number(process.argv[3] ?? 26);
  const overbought = Number(process.argv[4] ?? 74);

  console.log(`RSI Debug: BTCUSDT 5m, period=${String(rsiPeriod)}, oversold=${String(oversold)}, overbought=${String(overbought)}`);
  console.log(`Parity window: ${PARITY_START.toISOString().slice(0, 10)} -> ${PARITY_END.toISOString().slice(0, 10)}`);
  console.log(`Warmup: 90 days\n`);

  const storage = createStorage(DB_PATH);
  const loadStart = PARITY_START.getTime() - WARMUP_MS;
  const candles = storage.candles.getCandles(SYMBOL, TIMEFRAME, loadStart, PARITY_END.getTime());
  storage.close();

  console.log(`Loaded ${String(candles.length)} candles (${String(Math.round(candles.length / 288))} days)`);

  const rsiSeries = computeRsiSeries(candles, rsiPeriod);

  // Filter to parity period only
  const parityRsi = rsiSeries.filter((r) => r.time >= PARITY_START.getTime() && r.time < PARITY_END.getTime());

  console.log(`\nParity period candles: ${String(parityRsi.length)}`);
  console.log(`\n${'Time'.padEnd(22)} ${'Close'.padStart(12)} ${'RSI'.padStart(8)} ${'PrevRSI'.padStart(8)}  Signal`);
  console.log('─'.repeat(70));

  let prevRsi: number | null = null;
  let signalCount = 0;

  for (const r of parityRsi) {
    const rsi = r.rsi;
    let signal = '';

    if (rsi !== null && prevRsi !== null) {
      if (prevRsi <= oversold && rsi > oversold) {
        signal = '>>> LONG';
        signalCount++;
      }
      if (prevRsi >= overbought && rsi < overbought) {
        signal = '>>> SHORT';
        signalCount++;
      }
    }

    const timeStr = new Date(r.time).toISOString().replace('T', ' ').slice(0, 19);
    const rsiStr = rsi !== null ? rsi.toFixed(2) : '  null';
    const prevStr = prevRsi !== null ? prevRsi.toFixed(2) : '  null';

    // Only print candles near signals or first/last few
    if (signal || (rsi !== null && prevRsi !== null && (
      (Math.abs(rsi - oversold) < 3) || (Math.abs(rsi - overbought) < 3)
    ))) {
      console.log(`${timeStr}  ${r.close.toFixed(2).padStart(12)} ${rsiStr.padStart(8)} ${prevStr.padStart(8)}  ${signal}`);
    }

    prevRsi = rsi;
  }

  console.log(`\nTotal signals in period: ${String(signalCount)}`);
  console.log('\nTo compare with TV: add RSI(13) indicator to BTCUSDT 5m chart');
  console.log(`and check RSI values at the signal timestamps above.`);

  // Also dump first 10 RSI values in parity period for exact comparison
  console.log('\n─── First 10 RSI values in parity period (for exact comparison) ───');
  for (const r of parityRsi.slice(0, 10)) {
    const timeStr = new Date(r.time).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  ${timeStr}  close=${r.close.toFixed(2)}  rsi=${r.rsi !== null ? r.rsi.toFixed(6) : 'null'}`);
  }
}

main().catch((err) => {
  console.error('RSI debug failed:', err);
  process.exit(1);
});
