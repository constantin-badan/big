import { describe, test, expect } from 'bun:test';
import type { IScanner, ScannerFactory } from '../index';

describe('scanner', () => {
  test('IScanner interface is importable', () => {
    const scanner = {} as IScanner;
    expect(scanner).toBeDefined();
  });

  test('ScannerFactory type is importable', () => {
    const factory: ScannerFactory = () => ({} as IScanner);
    expect(factory).toBeDefined();
  });
});
