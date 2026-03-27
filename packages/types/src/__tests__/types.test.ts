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
