import { describe, test, expect } from 'bun:test';
import type { PositionState } from '../index';

describe('position-manager', () => {
  test('package is importable', async () => {
    const mod = await import('../index');
    expect(mod).toBeDefined();
  });

  test('PositionState type is correct', () => {
    const state: PositionState = 'IDLE';
    expect(state).toBe('IDLE');
  });
});
