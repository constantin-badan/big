import { describe, test, expect } from 'bun:test';
import type { ISweepEngine } from '../index';

describe('sweep-engine', () => {
  test('ISweepEngine interface is importable', () => {
    const engine = {} as ISweepEngine;
    expect(engine).toBeDefined();
  });
});
