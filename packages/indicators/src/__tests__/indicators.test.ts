import { describe, test, expect } from 'bun:test';
import type { IIndicator, IndicatorFactory } from '../index';

describe('indicators', () => {
  test('IIndicator interface is importable', () => {
    const indicator = {} as IIndicator<{ period: number }>;
    expect(indicator).toBeDefined();
  });

  test('IndicatorFactory type is importable', () => {
    const factory: IndicatorFactory<{ period: number }> = () => ({} as IIndicator<{ period: number }>);
    expect(factory).toBeDefined();
  });
});
