import { describe, test, expect } from 'bun:test';
import { createExchange } from '../factory';
import type { ExchangeConfig } from '@trading-bot/types';

describe('exchange-client', () => {
  test('module exports are importable', async () => {
    const mod = await import('../index');
    expect(mod.createExchange).toBeDefined();
  });

  test('createExchange throws for binance-live', () => {
    const config: ExchangeConfig = {
      type: 'binance-live',
      apiKey: 'key',
      apiSecret: 'secret',
    };
    expect(() => createExchange(config)).toThrow('Not implemented: binance-live');
  });

  test('createExchange throws for binance-testnet', () => {
    const config: ExchangeConfig = {
      type: 'binance-testnet',
      apiKey: 'key',
      apiSecret: 'secret',
    };
    expect(() => createExchange(config)).toThrow('Not implemented: binance-testnet');
  });

  test('createExchange throws for backtest-sim', () => {
    const config: ExchangeConfig = {
      type: 'backtest-sim',
      feeStructure: { maker: 0.0002, taker: 0.0004 },
      slippageModel: { type: 'fixed', fixedBps: 5 },
      initialBalance: 10000,
    };
    expect(() => createExchange(config)).toThrow('Not implemented: backtest-sim');
  });
});
