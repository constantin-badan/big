import { describe, test, expect } from 'bun:test';

import { EventBus } from '@trading-bot/event-bus';
import { toSymbol } from '@trading-bot/types';

import { EventCapture } from '../event-capture';
import { fixtures } from '../fixtures';
import { createTestBus } from '../index';
import { createMockExchange } from '../mock-exchange';
import { createMockExecutor } from '../mock-executor';

describe('EventCapture', () => {
  test('records emitted events', () => {
    const bus = new EventBus();
    const capture = new EventCapture(bus);

    bus.emit('tick', { symbol: toSymbol('BTCUSDT'), tick: fixtures.tick });

    expect(capture.count('tick')).toBe(1);
    expect(capture.get('tick')[0]?.symbol).toBe(toSymbol('BTCUSDT'));
  });

  test('last returns most recent event', () => {
    const bus = new EventBus();
    const capture = new EventCapture(bus);

    bus.emit('tick', { symbol: toSymbol('BTCUSDT'), tick: fixtures.tick });
    bus.emit('tick', { symbol: toSymbol('ETHUSDT'), tick: { ...fixtures.tick, symbol: toSymbol('ETHUSDT') } });

    expect(capture.last('tick')?.symbol).toBe(toSymbol('ETHUSDT'));
  });

  test('clear resets all recorded events', () => {
    const bus = new EventBus();
    const capture = new EventCapture(bus);

    bus.emit('tick', { symbol: toSymbol('BTCUSDT'), tick: fixtures.tick });
    capture.clear();

    expect(capture.count('tick')).toBe(0);
  });

  test('dispose stops capturing', () => {
    const bus = new EventBus();
    const capture = new EventCapture(bus);

    capture.dispose();
    bus.emit('tick', { symbol: toSymbol('BTCUSDT'), tick: fixtures.tick });

    expect(capture.count('tick')).toBe(0);
  });
});

describe('createTestBus', () => {
  test('returns bus and capture pre-wired', () => {
    const { bus, capture } = createTestBus();

    bus.emit('tick', { symbol: toSymbol('BTCUSDT'), tick: fixtures.tick });

    expect(capture.count('tick')).toBe(1);
  });
});

describe('createMockExchange', () => {
  test('returns an IExchange where all methods resolve', async () => {
    const exchange = createMockExchange();

    const candles = await exchange.getCandles(toSymbol('BTCUSDT'), '1m', 100);
    expect(candles).toEqual([]);

    const position = await exchange.getPosition(toSymbol('BTCUSDT'));
    expect(position).toBeNull();

    expect(exchange.isConnected()).toBe(false);
    await exchange.connect();
    expect(exchange.isConnected()).toBe(true);
  });

  test('returns configured candles', async () => {
    const exchange = createMockExchange({ candles: fixtures.candles });
    const result = await exchange.getCandles(toSymbol('BTCUSDT'), '1m', 100);
    expect(result).toHaveLength(100);
  });
});

describe('createMockExecutor', () => {
  test('syncFill emits order:filled on submit', () => {
    const { bus, capture } = createTestBus();
    const executor = createMockExecutor(bus, { syncFill: true });

    const receipt = executor.submit({
      symbol: toSymbol('BTCUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.1,
    });

    expect(receipt.symbol).toBe(toSymbol('BTCUSDT'));
    expect(capture.count('order:submitted')).toBe(1);
    expect(capture.count('order:filled')).toBe(1);
  });

  test('syncFill false does not emit fill', () => {
    const { bus, capture } = createTestBus();
    const executor = createMockExecutor(bus, { syncFill: false });

    executor.submit({
      symbol: toSymbol('BTCUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.1,
    });

    expect(capture.count('order:submitted')).toBe(1);
    expect(capture.count('order:filled')).toBe(0);
  });

  test('rejectAll emits order:rejected', () => {
    const { bus, capture } = createTestBus();
    const executor = createMockExecutor(bus, { rejectAll: true });

    executor.submit({
      symbol: toSymbol('BTCUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.1,
    });

    expect(capture.count('order:rejected')).toBe(1);
    expect(capture.count('order:filled')).toBe(0);
  });
});

describe('fixtures', () => {
  test('all fixtures have deterministic values', () => {
    expect(fixtures.candle.openTime).toBe(1700000000000);
    expect(fixtures.tick.price).toBe(50000);
    expect(fixtures.longSignal.action).toBe('ENTER_LONG');
    expect(fixtures.candles).toHaveLength(100);
  });
});
