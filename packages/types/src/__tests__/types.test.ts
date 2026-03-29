import { describe, test, expect } from 'bun:test';

import type {
  Candle,
  ExchangeConfig,
  ExchangeStream,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  RiskRule,
  RiskSeverity,
  SignalAction,
  Timeframe,
} from '../index';
import { KahanSum } from '../index';

describe('types', () => {
  test('Candle type is constructible', () => {
    const candle: Candle = {
      openTime: 1000,
      closeTime: 2000,
      open: 50000,
      high: 51000,
      low: 49000,
      close: 50500,
      volume: 100,
      quoteVolume: 5000000,
      trades: 500,
      isClosed: true,
    };
    expect(candle.isClosed).toBe(true);
  });

  test('ExchangeConfig discriminated union works', () => {
    const liveConfig: ExchangeConfig = {
      type: 'binance-live',
      apiKey: 'key',
      privateKey: 'secret',
    };

    const simConfig: ExchangeConfig = {
      type: 'backtest-sim',
      feeStructure: { maker: 0.0002, taker: 0.0004 },
      slippageModel: { type: 'fixed', fixedBps: 5 },
      initialBalance: 10000,
    };

    expect(liveConfig.type).toBe('binance-live');
    expect(simConfig.type).toBe('backtest-sim');
  });

  test('literal types are correct', () => {
    const tf: Timeframe = '15m';
    const side: OrderSide = 'BUY';
    const ot: OrderType = 'LIMIT';
    const os: OrderStatus = 'FILLED';
    const ps: PositionSide = 'LONG';
    const sa: SignalAction = 'ENTER_LONG';
    const es: ExchangeStream = 'kline';
    const rr: RiskRule = 'MAX_DRAWDOWN';
    const rs: RiskSeverity = 'KILL';
    expect(tf).toBe('15m');
    expect(side).toBe('BUY');
    expect(ot).toBe('LIMIT');
    expect(os).toBe('FILLED');
    expect(ps).toBe('LONG');
    expect(sa).toBe('ENTER_LONG');
    expect(es).toBe('kline');
    expect(rr).toBe('MAX_DRAWDOWN');
    expect(rs).toBe('KILL');
  });
});

describe('KahanSum', () => {
  test('value is 0 after construction', () => {
    const ks = new KahanSum();
    expect(ks.value).toBe(0);
  });

  test('basic addition: 1 + 2 + 3 = 6', () => {
    const ks = new KahanSum();
    ks.add(1);
    ks.add(2);
    ks.add(3);
    expect(ks.value).toBe(6);
  });

  test('compensated summation: adding 0.1 ten times equals 1.0', () => {
    const ks = new KahanSum();
    for (let i = 0; i < 10; i++) {
      ks.add(0.1);
    }
    // Naive summation drifts: 0.1 + 0.1 + ... != 1.0 in IEEE 754
    let naive = 0;
    for (let i = 0; i < 10; i++) {
      naive += 0.1;
    }
    const kahanError = Math.abs(ks.value - 1.0);
    const naiveError = Math.abs(naive - 1.0);
    expect(kahanError).toBeLessThanOrEqual(naiveError);
    expect(ks.value).toBeCloseTo(1.0, 15);
  });

  test('large + small number accuracy: 1e15 + 1.0 - 1e15 = 1.0', () => {
    const ks = new KahanSum();
    ks.add(1e15);
    ks.add(1.0);
    ks.add(-1e15);
    expect(ks.value).toBe(1.0);
  });

  test('throws on NaN input', () => {
    const ks = new KahanSum();
    expect(() => ks.add(NaN)).toThrow('non-finite');
  });

  test('throws on Infinity input', () => {
    const ks = new KahanSum();
    expect(() => ks.add(Infinity)).toThrow('non-finite');
  });

  test('throws on -Infinity input', () => {
    const ks = new KahanSum();
    expect(() => ks.add(-Infinity)).toThrow('non-finite');
  });

  test('reset clears sum and compensation', () => {
    const ks = new KahanSum();
    ks.add(42);
    ks.add(0.1);
    ks.add(0.1);
    ks.add(0.1);
    ks.reset();
    expect(ks.value).toBe(0);
    // After reset, adding values should work fresh with no leftover compensation
    ks.add(5);
    expect(ks.value).toBe(5);
  });

  test('adding zero does not change value', () => {
    const ks = new KahanSum();
    ks.add(3.14);
    const before = ks.value;
    ks.add(0);
    expect(ks.value).toBe(before);
  });

  test('negative numbers work correctly', () => {
    const ks = new KahanSum();
    ks.add(10);
    ks.add(-3);
    ks.add(-7);
    expect(ks.value).toBe(0);
  });
});
