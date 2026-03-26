import { describe, test, expect } from 'bun:test';

describe('live-runner', () => {
  test('package is importable', async () => {
    const mod = await import('../index');
    expect(mod).toBeDefined();
  });
});
