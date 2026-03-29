import { describe, test, expect } from 'bun:test';

import type { IEventBus } from '@trading-bot/event-bus';
import { createTestBus, EventCapture } from '@trading-bot/test-utils';
import type { OrderRequest, OrderResult, OrderStatus } from '@trading-bot/types';
import { toSymbol, toOrderId, toClientOrderId } from '@trading-bot/types';

import { BacktestExecutor } from '../backtest-executor';
import type { IFillSimulator } from '../types';

function makeFillSim(status: OrderStatus = 'FILLED'): IFillSimulator {
  return {
    simulateFill(request): OrderResult {
      const orderPrice =
        request.type === 'LIMIT'
          ? request.price
          : request.type === 'STOP_MARKET' || request.type === 'TAKE_PROFIT_MARKET'
            ? request.stopPrice
            : undefined;
      return {
        orderId: toOrderId('sim-order-1'),
        clientOrderId: request.clientOrderId ?? toClientOrderId('sim-client-1'),
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        status,
        price: orderPrice ?? 50000,
        avgPrice: orderPrice ?? 50000,
        quantity: request.quantity,
        filledQuantity: status === 'FILLED' ? request.quantity : 0,
        commission: 0,
        commissionAsset: 'USDT',
        timestamp: Date.now(),
        latencyMs: 0,
      };
    },
  };
}

const baseRequest: OrderRequest = {
  symbol: toSymbol('BTCUSDT'),
  side: 'BUY',
  type: 'MARKET',
  quantity: 0.1,
  clientOrderId: toClientOrderId('test-client-1'),
};

function makeExecutor(status: OrderStatus = 'FILLED'): {
  bus: IEventBus;
  capture: EventCapture;
  executor: BacktestExecutor;
} {
  let bus: IEventBus;
  ({ bus } = createTestBus());
  const capture = new EventCapture(bus);
  const executor = new BacktestExecutor(bus, makeFillSim(status));
  return { bus, capture, executor };
}

describe('BacktestExecutor', () => {
  test('submit() emits order:submitted then order:filled synchronously before submit() returns', () => {
    const { capture, executor } = makeExecutor('FILLED');

    executor.submit(baseRequest);

    // Both events must be captured BEFORE submit() returns (it's synchronous)
    expect(capture.count('order:submitted')).toBe(1);
    expect(capture.count('order:filled')).toBe(1);
    expect(capture.count('order:rejected')).toBe(0);

    capture.dispose();
  });

  test('submit() returns correct SubmissionReceipt fields', () => {
    const { capture, executor } = makeExecutor('FILLED');

    const receipt = executor.submit(baseRequest);

    expect(receipt.clientOrderId).toBe(toClientOrderId('test-client-1'));
    expect(receipt.symbol).toBe(toSymbol('BTCUSDT'));
    expect(receipt.side).toBe('BUY');
    expect(receipt.type).toBe('MARKET');
    expect(receipt.quantity).toBe(0.1);
    expect(typeof receipt.submittedAt).toBe('number');

    capture.dispose();
  });

  test('submit() with REJECTED status emits order:rejected', () => {
    const { capture, executor } = makeExecutor('REJECTED');

    executor.submit(baseRequest);

    expect(capture.count('order:submitted')).toBe(1);
    expect(capture.count('order:filled')).toBe(0);
    expect(capture.count('order:rejected')).toBe(1);

    capture.dispose();
  });

  test('order:submitted fires before order:filled (check event order)', () => {
    let bus: IEventBus;
    ({ bus } = createTestBus());
    const eventOrder: string[] = [];

    bus.on('order:submitted', () => {
      eventOrder.push('order:submitted');
    });
    bus.on('order:filled', () => {
      eventOrder.push('order:filled');
    });

    const executor = new BacktestExecutor(bus, makeFillSim('FILLED'));
    executor.submit(baseRequest);

    expect(eventOrder).toEqual(['order:submitted', 'order:filled']);
  });

  test('hasPending() always returns false', () => {
    const { executor } = makeExecutor('FILLED');

    expect(executor.hasPending(toSymbol('BTCUSDT'))).toBe(false);
    executor.submit(baseRequest);
    expect(executor.hasPending(toSymbol('BTCUSDT'))).toBe(false);
  });

  test('getPendingCount() always returns 0', () => {
    const { executor } = makeExecutor('FILLED');

    expect(executor.getPendingCount()).toBe(0);
    executor.submit(baseRequest);
    expect(executor.getPendingCount()).toBe(0);
  });

  test('multiple sequential submit() calls each emit their own events', () => {
    const { capture, executor } = makeExecutor('FILLED');

    const request2: OrderRequest = { ...baseRequest, clientOrderId: toClientOrderId('test-client-2') };
    const request3: OrderRequest = { ...baseRequest, clientOrderId: toClientOrderId('test-client-3') };

    executor.submit(baseRequest);
    executor.submit(request2);
    executor.submit(request3);

    expect(capture.count('order:submitted')).toBe(3);
    expect(capture.count('order:filled')).toBe(3);

    capture.dispose();
  });

  test('auto-generated clientOrderId when not provided', () => {
    const { capture, executor } = makeExecutor('FILLED');

    const requestWithoutId: OrderRequest = {
      symbol: toSymbol('BTCUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.1,
    };

    const receipt = executor.submit(requestWithoutId);

    expect(typeof receipt.clientOrderId).toBe('string');
    expect(receipt.clientOrderId.length).toBeGreaterThan(0);

    // The emitted receipt should also carry the generated id
    const submitted = capture.last('order:submitted');
    expect(submitted?.receipt.clientOrderId).toBe(receipt.clientOrderId);

    capture.dispose();
  });

  test('auto-generated clientOrderIds are unique across calls', () => {
    const { executor } = makeExecutor('FILLED');

    const requestWithoutId: OrderRequest = {
      symbol: toSymbol('BTCUSDT'),
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.1,
    };

    const receipt1 = executor.submit(requestWithoutId);
    const receipt2 = executor.submit(requestWithoutId);

    expect(receipt1.clientOrderId).not.toBe(receipt2.clientOrderId);
  });

  test('start() resolves immediately', async () => {
    const { executor } = makeExecutor('FILLED');
    await expect(executor.start()).resolves.toBeUndefined();
  });

  test('stop() resolves immediately', async () => {
    const { executor } = makeExecutor('FILLED');
    await expect(executor.stop()).resolves.toBeUndefined();
  });
});
