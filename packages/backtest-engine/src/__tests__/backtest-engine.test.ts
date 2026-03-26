import { describe, test, expect } from 'bun:test';
import type { IBacktestEngine } from '../index';

describe('backtest-engine', () => {
  test('IBacktestEngine interface is importable', () => {
    const engine = {} as IBacktestEngine;
    expect(engine).toBeDefined();
  });
});
