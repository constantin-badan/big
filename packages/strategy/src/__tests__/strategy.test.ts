import { describe, test, expect } from 'bun:test';
import type { IStrategy, StrategyFactory, SignalMerge } from '../index';

describe('strategy', () => {
  test('IStrategy interface is importable', () => {
    const strategy = {} as IStrategy;
    expect(strategy).toBeDefined();
  });

  test('StrategyFactory type is importable', () => {
    const factory: StrategyFactory = () => ({} as IStrategy);
    expect(factory).toBeDefined();
  });

  test('SignalMerge type is importable', () => {
    const merge: SignalMerge = (trigger) => trigger;
    expect(merge).toBeDefined();
  });
});
