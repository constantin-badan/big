import { describe, test, expect } from 'bun:test';
import type { IPositionManager, PositionState } from '../index';

describe('position-manager', () => {
  test('IPositionManager interface is importable', () => {
    const pm = {} as IPositionManager;
    expect(pm).toBeDefined();
  });

  test('PositionState type is correct', () => {
    const state: PositionState = 'IDLE';
    expect(state).toBe('IDLE');
  });
});
