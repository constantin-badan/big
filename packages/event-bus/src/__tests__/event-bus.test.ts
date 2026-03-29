import { describe, test, expect, spyOn } from 'bun:test';

import type { Tick } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { EventBus } from '../event-bus';
import type { TradingEventMap } from '../types';

const BTCUSDT = toSymbol('BTCUSDT');

const testTick: Tick = {
  symbol: BTCUSDT,
  price: 50000,
  quantity: 1,
  timestamp: 1000,
  isBuyerMaker: false,
};

const tickPayload: TradingEventMap['tick'] = {
  symbol: BTCUSDT,
  tick: testTick,
};

describe('EventBus', () => {
  test('on/emit delivers events to handlers', () => {
    const bus = new EventBus();
    const received: TradingEventMap['tick'][] = [];

    bus.on('tick', (data) => {
      received.push(data);
    });

    bus.emit('tick', tickPayload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(tickPayload);
  });

  test('multiple handlers receive the same event', () => {
    const bus = new EventBus();
    let count = 0;

    bus.on('tick', () => {
      count++;
    });
    bus.on('tick', () => {
      count++;
    });

    bus.emit('tick', tickPayload);
    expect(count).toBe(2);
  });

  test('off removes a specific handler', () => {
    const bus = new EventBus();
    let count = 0;
    const handler = () => {
      count++;
    };

    bus.on('tick', handler);
    bus.emit('tick', tickPayload);
    expect(count).toBe(1);

    bus.off('tick', handler);
    bus.emit('tick', tickPayload);
    expect(count).toBe(1);
  });

  test('once fires handler only once', () => {
    const bus = new EventBus();
    let count = 0;

    bus.once('tick', () => {
      count++;
    });

    bus.emit('tick', tickPayload);
    bus.emit('tick', tickPayload);

    expect(count).toBe(1);
  });

  test('error in one handler does not affect others', () => {
    const bus = new EventBus();
    const results: number[] = [];

    bus.on('tick', () => {
      throw new Error('boom');
    });
    bus.on('tick', () => {
      results.push(1);
    });

    const spy = spyOn(console, 'error').mockImplementation(() => {});
    bus.emit('tick', tickPayload);
    spy.mockRestore();

    expect(results).toEqual([1]);
  });

  test('error handler logs event name', () => {
    const bus = new EventBus();
    bus.on('tick', () => {
      throw new Error('boom');
    });

    const calls: unknown[][] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    bus.emit('tick', tickPayload);
    spy.mockRestore();

    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain('tick');
  });

  test('removeAllListeners for a specific event', () => {
    const bus = new EventBus();
    let tickCount = 0;
    let errorCount = 0;

    bus.on('tick', () => {
      tickCount++;
    });
    bus.on('error', () => {
      errorCount++;
    });

    bus.removeAllListeners('tick');

    bus.emit('tick', tickPayload);
    bus.emit('error', { source: 'test', error: new Error('e') });

    expect(tickCount).toBe(0);
    expect(errorCount).toBe(1);
  });

  test('removeAllListeners without args clears everything', () => {
    const bus = new EventBus();
    let count = 0;

    bus.on('tick', () => {
      count++;
    });
    bus.on('error', () => {
      count++;
    });

    bus.removeAllListeners();

    bus.emit('tick', tickPayload);
    bus.emit('error', { source: 'test', error: new Error('e') });

    expect(count).toBe(0);
  });

  test('listenerCount returns correct count', () => {
    const bus = new EventBus();

    expect(bus.listenerCount('tick')).toBe(0);

    const h1 = () => {};
    const h2 = () => {};

    bus.on('tick', h1);
    expect(bus.listenerCount('tick')).toBe(1);

    bus.on('tick', h2);
    expect(bus.listenerCount('tick')).toBe(2);

    bus.off('tick', h1);
    expect(bus.listenerCount('tick')).toBe(1);
  });

  test('emit is synchronous', () => {
    const bus = new EventBus();
    const order: number[] = [];

    bus.on('tick', () => {
      order.push(1);
    });
    bus.on('tick', () => {
      order.push(2);
    });

    order.push(0);
    bus.emit('tick', tickPayload);
    order.push(3);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  test('emitting without listeners does not throw', () => {
    const bus = new EventBus();
    expect(() => bus.emit('tick', tickPayload)).not.toThrow();
  });

  describe('re-entrant emit', () => {
    test('handler that emits same event causes nested execution', () => {
      const bus = new EventBus();
      const calls: number[] = [];

      bus.on('tick', () => {
        calls.push(1);
        if (calls.length === 1) {
          bus.emit('tick', tickPayload);
        }
      });
      bus.on('tick', () => {
        calls.push(2);
      });

      bus.emit('tick', tickPayload);

      // Outer handler1 pushes 1, re-emits → nested handler1 pushes 1, nested handler2 pushes 2,
      // then outer handler2 pushes 2
      expect(calls).toEqual([1, 1, 2, 2]);
    });

    test('handler added during emit does not fire in current cycle', () => {
      const bus = new EventBus();
      let handler2Called = false;

      const handler2 = () => {
        handler2Called = true;
      };

      bus.on('tick', () => {
        bus.on('tick', handler2);
      });

      bus.emit('tick', tickPayload);
      expect(handler2Called).toBe(false);

      bus.emit('tick', tickPayload);
      expect(handler2Called).toBe(true);
    });
  });
});
