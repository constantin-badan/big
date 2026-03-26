import { describe, test, expect } from 'bun:test';
import type { RiskCheckResult } from '../index';

describe('risk-manager', () => {
  test('package is importable', async () => {
    const mod = await import('../index');
    expect(mod).toBeDefined();
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
