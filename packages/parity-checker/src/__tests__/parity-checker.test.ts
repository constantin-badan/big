import { describe, test, expect } from 'bun:test';

describe('parity-checker', () => {
  test('package is importable', async () => {
    const mod = await import('../index');
    expect(mod).toBeDefined();
  });
});
