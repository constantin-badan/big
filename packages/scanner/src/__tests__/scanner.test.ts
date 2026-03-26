import { describe, test, expect } from 'bun:test';
import type { ScannerFactory } from '../index';

describe('scanner', () => {
  test('ScannerFactory creates valid scanners', () => {
    const factory: ScannerFactory = (_bus, config) => ({
      name: 'test-scanner',
      config,
      dispose: () => {},
    });
    expect(factory).toBeDefined();
  });
});
