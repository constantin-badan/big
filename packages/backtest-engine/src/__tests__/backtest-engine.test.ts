import { describe, test, expect } from 'bun:test';

describe('backtest-engine', () => {
  test('package is importable', async () => {
    const mod = await import('../index');
    expect(mod).toBeDefined();
  });
});
