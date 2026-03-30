import { describe, expect, it } from 'bun:test';
import { createBinanceFetcher, classifyWeeks, selectStratifiedWeeks, runTournament } from '../index';
import type { RunConfig } from '../index';

describe('runner', () => {
  it('exports createBinanceFetcher', () => {
    expect(createBinanceFetcher).toBeInstanceOf(Function);
  });

  it('createBinanceFetcher returns a function', () => {
    const fetcher = createBinanceFetcher();
    expect(fetcher).toBeInstanceOf(Function);
  });

  it('exports classifyWeeks', () => {
    expect(classifyWeeks).toBeInstanceOf(Function);
  });

  it('exports selectStratifiedWeeks', () => {
    expect(selectStratifiedWeeks).toBeInstanceOf(Function);
  });

  it('selectStratifiedWeeks returns all when count >= available', () => {
    const weeks = [
      { startTime: 0, endTime: 1, regime: 'TRENDING' as const, returnPct: 5, volatility: 0.1 },
      { startTime: 1, endTime: 2, regime: 'RANGING' as const, returnPct: 0.5, volatility: 0.05 },
    ];
    const result = selectStratifiedWeeks(weeks, 10);
    expect(result).toHaveLength(2);
  });

  it('exports runTournament', () => {
    expect(runTournament).toBeInstanceOf(Function);
  });

  it('RunConfig type is usable', () => {
    // Type-level check — if this compiles, the type is exported correctly
    const partial: Partial<RunConfig> = { timeframe: '5m' };
    expect(partial.timeframe).toBe('5m');
  });
});
