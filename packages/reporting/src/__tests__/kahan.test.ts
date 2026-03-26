import { describe, test, expect } from 'bun:test';
import { KahanSum } from '../kahan';

describe('KahanSum', () => {
  test('summing 0.1 ten thousand times gives exactly 1000', () => {
    const kahan = new KahanSum();
    for (let i = 0; i < 10_000; i++) {
      kahan.add(0.1);
    }
    expect(kahan.value).toBe(1000);
  });

  test('naive summation drifts but KahanSum does not', () => {
    let naive = 0;
    const kahan = new KahanSum();

    for (let i = 0; i < 10_000; i++) {
      naive += 0.1;
      kahan.add(0.1);
    }

    expect(naive).not.toBe(1000);
    expect(kahan.value).toBe(1000);
  });

  test('alternating large and small values preserves the residual', () => {
    const kahan = new KahanSum();
    const large = 1e15;
    const small = 1.0;

    kahan.add(large);
    kahan.add(small);
    kahan.add(-large);

    expect(kahan.value).toBe(small);
  });

  test('reset zeroes both sum and compensation', () => {
    const kahan = new KahanSum();
    kahan.add(42);
    kahan.add(0.1);
    kahan.reset();

    expect(kahan.value).toBe(0);

    kahan.add(1);
    expect(kahan.value).toBe(1);
  });

  test('empty sum is zero', () => {
    const kahan = new KahanSum();
    expect(kahan.value).toBe(0);
  });
});
