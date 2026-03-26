import { describe, test, expect } from 'bun:test';
import type { StrategyFactory, SignalMerge } from '../index';

describe('strategy', () => {
  test('StrategyFactory creates valid strategies', () => {
    const factory: StrategyFactory = (_params) => ({
      name: 'test-strategy',
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      getStats: () => ({
        totalTrades: 0,
        winRate: 0,
        profitFactor: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        maxDrawdownDuration: 0,
        avgWin: 0,
        avgLoss: 0,
        expectancy: 0,
        avgHoldTime: 0,
        totalFees: 0,
        totalSlippage: 0,
      }),
    });
    const strategy = factory({ period: 14 });
    expect(strategy.name).toBe('test-strategy');
  });

  test('SignalMerge type is usable', () => {
    const merge: SignalMerge = (trigger) => trigger;
    expect(merge).toBeDefined();
  });
});
