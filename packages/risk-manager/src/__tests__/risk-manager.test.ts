import { describe, test, expect } from 'bun:test';
import type { IRiskManager, RiskCheckResult } from '../index';

describe('risk-manager', () => {
  test('IRiskManager interface is importable', () => {
    const rm = {} as IRiskManager;
    expect(rm).toBeDefined();
  });

  test('RiskCheckResult discriminated union works', () => {
    const allowed: RiskCheckResult = { allowed: true };
    const rejected: RiskCheckResult = {
      allowed: false,
      rule: 'MAX_DRAWDOWN',
      reason: 'Drawdown exceeded',
      severity: 'KILL',
    };
    expect(allowed.allowed).toBe(true);
    expect(rejected.allowed).toBe(false);
  });
});
