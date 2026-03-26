import { describe, test, expect } from 'bun:test';

import type { IndicatorFactory } from '../index';

describe('indicators', () => {
  test('IndicatorFactory creates valid indicators', () => {
    const factory: IndicatorFactory<{ period: number }> = (config) => ({
      name: 'test-ema',
      warmupPeriod: config.period,
      config,
      update: () => null,
      reset: () => {},
    });
    const indicator = factory({ period: 14 });
    expect(indicator.name).toBe('test-ema');
    expect(indicator.warmupPeriod).toBe(14);
  });
});
