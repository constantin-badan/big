/**
 * Simple regime detection for stratified sampling.
 * Classifies time periods as TRENDING, RANGING, or VOLATILE
 * based on price action statistics.
 */
import type { Candle, Symbol, Timeframe } from '@trading-bot/types';
import type { ICandleStore } from '@trading-bot/storage';

export type Regime = 'TRENDING' | 'RANGING' | 'VOLATILE';

export interface ClassifiedWeek {
  startTime: number;
  endTime: number;
  regime: Regime;
  returnPct: number;
  volatility: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Classifies a period based on candle data:
 * - TRENDING: |return| > 3% and low intra-period reversal
 * - VOLATILE: high standard deviation of returns (> 1.5× median)
 * - RANGING: everything else
 */
function classifyPeriod(candles: Candle[]): { regime: Regime; returnPct: number; volatility: number } {
  if (candles.length < 10) {
    return { regime: 'RANGING', returnPct: 0, volatility: 0 };
  }

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const returnPct = ((last.close - first.close) / first.close) * 100;

  // Compute per-candle returns
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const curr = candles[i]!.close;
    if (prev > 0) returns.push((curr - prev) / prev);
  }

  // Standard deviation of returns
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance) * 100; // as percentage

  // Classification
  if (volatility > 0.15) return { regime: 'VOLATILE', returnPct, volatility };
  if (Math.abs(returnPct) > 3) return { regime: 'TRENDING', returnPct, volatility };
  return { regime: 'RANGING', returnPct, volatility };
}

/**
 * Classifies all possible weeks in the data range.
 * Uses a reference symbol to determine regime (assumes correlated markets).
 */
export function classifyWeeks(
  store: ICandleStore,
  symbol: Symbol,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
): ClassifiedWeek[] {
  const weeks: ClassifiedWeek[] = [];
  let cursor = startTime;

  while (cursor + WEEK_MS <= endTime) {
    const candles = store.getCandles(symbol, timeframe, cursor, cursor + WEEK_MS);
    const { regime, returnPct, volatility } = classifyPeriod(candles);

    weeks.push({
      startTime: cursor,
      endTime: cursor + WEEK_MS,
      regime,
      returnPct,
      volatility,
    });

    cursor += WEEK_MS;
  }

  return weeks;
}

/**
 * Select weeks with stratified regime diversity.
 * Ensures at least one week from each available regime type.
 * Remaining slots filled randomly from all regimes.
 */
export function selectStratifiedWeeks(
  classifiedWeeks: ClassifiedWeek[],
  count: number,
): ClassifiedWeek[] {
  if (classifiedWeeks.length <= count) return [...classifiedWeeks];

  const byRegime = new Map<Regime, ClassifiedWeek[]>();
  for (const w of classifiedWeeks) {
    const list = byRegime.get(w.regime) ?? [];
    list.push(w);
    byRegime.set(w.regime, list);
  }

  const selected: ClassifiedWeek[] = [];
  const used = new Set<number>();

  // Phase 1: one from each available regime
  for (const [, weeks] of byRegime) {
    if (selected.length >= count) break;
    const idx = Math.floor(Math.random() * weeks.length);
    const week = weeks[idx]!;
    selected.push(week);
    used.add(week.startTime);
  }

  // Phase 2: fill remaining slots randomly
  const remaining = classifiedWeeks.filter((w) => !used.has(w.startTime));
  while (selected.length < count && remaining.length > 0) {
    const idx = Math.floor(Math.random() * remaining.length);
    selected.push(remaining.splice(idx, 1)[0]!);
  }

  return selected;
}
