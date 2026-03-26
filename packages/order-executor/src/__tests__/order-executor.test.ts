import { describe, test, expect } from 'bun:test';
import type { IOrderExecutor } from '../index';

describe('order-executor', () => {
  test('IOrderExecutor interface is importable', () => {
    const executor = {} as IOrderExecutor;
    expect(executor).toBeDefined();
  });
});
