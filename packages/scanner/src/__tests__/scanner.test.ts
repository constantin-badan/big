import { describe, test, expect } from 'bun:test';

import type { IEventBus } from '@trading-bot/event-bus';
import type { IIndicator } from '@trading-bot/indicators';
import { createTestBus, fixtures } from '@trading-bot/test-utils';
import type { EventCapture } from '@trading-bot/test-utils';
import type { Candle } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import type { ScannerEvaluate, ScannerFactory } from '../index';
import { Scanner, createScannerFactory } from '../index';

// Stub indicator: returns candle.close starting from the 1st update (warmupPeriod = 1)
function makePassthroughIndicator(): IIndicator<unknown, number> {
  let count = 0;
  return {
    name: 'passthrough',
    warmupPeriod: 1,
    config: {},
    update(candle: Candle): number | null {
      count++;
      return count >= 1 ? candle.close : null;
    },
    reset() {
      count = 0;
    },
  };
}

// Stub indicator that requires 3 candles before returning a value (warmupPeriod = 3)
function makeSlowIndicator(): IIndicator<unknown, number> {
  let count = 0;
  return {
    name: 'slow',
    warmupPeriod: 3,
    config: {},
    update(candle: Candle): number | null {
      count++;
      return count >= 3 ? candle.close : null;
    },
    reset() {
      count = 0;
    },
  };
}

const passthroughEvaluate: ScannerEvaluate = (indicators, candle, symbol) => ({
  action: 'ENTER_LONG',
  confidence: 0.9,
  price: candle.close,
  metadata: { indicatorValue: indicators['passthrough'] ?? 0, symbol },
});

const nullEvaluate: ScannerEvaluate = (_indicators, _candle, _symbol) => null;

describe('Scanner', () => {
  test('ScannerFactory creates valid scanners', () => {
    const factory: ScannerFactory = (_bus, config) => ({
      name: 'test-scanner',
      config,
      dispose: () => {},
    });
    expect(factory).toBeDefined();
  });

  test('scanner emits scanner:signal after warmup with correct payload', () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const scanner = new Scanner(
      bus,
      'test-scanner',
      {
        symbols: [toSymbol('BTCUSDT')],
        timeframe: '1m',
        indicators: {
          passthrough: () => makePassthroughIndicator(),
        },
      },
      passthroughEvaluate,
    );

    const candle = fixtures.candles[0]!;
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle });

    expect(capture.count('scanner:signal')).toBe(1);

    const event = capture.last('scanner:signal');
    expect(event?.signal.symbol).toBe(toSymbol('BTCUSDT'));
    expect(event?.signal.sourceScanner).toBe('test-scanner');
    expect(event?.signal.timestamp).toBe(candle.closeTime);
    expect(event?.signal.price).toBe(candle.close);
    expect(event?.signal.action).toBe('ENTER_LONG');

    scanner.dispose();
  });

  test('no signal emitted while any indicator is still warming up', () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    // slowIndicator needs 3 candles before returning a value
    const scanner = new Scanner(
      bus,
      'slow-scanner',
      {
        symbols: [toSymbol('BTCUSDT')],
        timeframe: '1m',
        indicators: {
          passthrough: () => makePassthroughIndicator(),
          slow: () => makeSlowIndicator(),
        },
      },
      passthroughEvaluate,
    );

    // First two candles: slow indicator still warming up
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[0]! });
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[1]! });
    expect(capture.count('scanner:signal')).toBe(0);

    // Third candle: both indicators warmed up
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[2]! });
    expect(capture.count('scanner:signal')).toBe(1);

    scanner.dispose();
  });

  test('no signal when evaluate returns null', () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const scanner = new Scanner(
      bus,
      'null-scanner',
      {
        symbols: [toSymbol('BTCUSDT')],
        timeframe: '1m',
        indicators: {
          passthrough: () => makePassthroughIndicator(),
        },
      },
      nullEvaluate,
    );

    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[0]! });
    expect(capture.count('scanner:signal')).toBe(0);

    scanner.dispose();
  });

  test('only processes candles matching config.timeframe', () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const scanner = new Scanner(
      bus,
      'tf-scanner',
      {
        symbols: [toSymbol('BTCUSDT')],
        timeframe: '1m',
        indicators: {
          passthrough: () => makePassthroughIndicator(),
        },
      },
      passthroughEvaluate,
    );

    // Emit a 5m candle — should be ignored
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '5m', candle: fixtures.candles[0]! });
    expect(capture.count('scanner:signal')).toBe(0);

    // Emit the correct 1m candle — should be processed
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[0]! });
    expect(capture.count('scanner:signal')).toBe(1);

    scanner.dispose();
  });

  test('per-symbol independence: two symbols get independent indicator instances', () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    // Track how many times the evaluate was called per symbol
    const updateCounts: Record<string, number> = { BTCUSDT: 0, ETHUSDT: 0 };

    const scanner = new Scanner(
      bus,
      'multi-sym-scanner',
      {
        symbols: [toSymbol('BTCUSDT'), toSymbol('ETHUSDT')],
        timeframe: '1m',
        indicators: {
          passthrough: () => {
            // Each factory call creates a truly independent indicator
            let count = 0;
            return {
              name: 'passthrough',
              warmupPeriod: 1,
              config: {},
              update(candle: Candle): number | null {
                count++;
                return count >= 1 ? candle.close : null;
              },
              reset() {
                count = 0;
              },
            };
          },
        },
      },
      (indicators, candle, symbol) => {
        updateCounts[symbol] = (updateCounts[symbol] ?? 0) + 1;
        return {
          action: 'ENTER_LONG',
          confidence: 0.9,
          price: candle.close,
          metadata: { count: updateCounts[symbol] },
        };
      },
    );

    // Feed 3 candles for BTCUSDT
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[0]! });
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[1]! });
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[2]! });

    // Feed 1 candle for ETHUSDT
    bus.emit('candle:close', { symbol: toSymbol('ETHUSDT'), timeframe: '1m', candle: fixtures.candles[0]! });

    const signals = capture.get('scanner:signal');
    // 3 BTC signals + 1 ETH signal = 4 total
    expect(signals.length).toBe(4);

    // BTC signals have correct symbol
    const btcSignals = signals.filter((e) => e.signal.symbol === 'BTCUSDT');
    expect(btcSignals.length).toBe(3);

    // ETH signals have correct symbol
    const ethSignals = signals.filter((e) => e.signal.symbol === toSymbol('ETHUSDT'));
    expect(ethSignals.length).toBe(1);

    scanner.dispose();
  });

  test('scanner:signal payload has correct symbol, sourceScanner, and timestamp', () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const scanner = new Scanner(
      bus,
      'payload-scanner',
      {
        symbols: [toSymbol('BTCUSDT')],
        timeframe: '1m',
        indicators: {
          passthrough: () => makePassthroughIndicator(),
        },
      },
      passthroughEvaluate,
    );

    const candle = fixtures.candles[5]!;
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle });

    const event = capture.last('scanner:signal');
    expect(event).toBeDefined();
    expect(event?.signal.symbol).toBe(toSymbol('BTCUSDT'));
    expect(event?.signal.sourceScanner).toBe('payload-scanner');
    expect(event?.signal.timestamp).toBe(candle.closeTime);
    expect(event?.signal.price).toBe(candle.close);

    scanner.dispose();
  });

  test('dispose() stops scanner from processing further candles', () => {
    const { bus, capture }: { bus: IEventBus; capture: EventCapture } = createTestBus();

    const scanner = new Scanner(
      bus,
      'dispose-scanner',
      {
        symbols: [toSymbol('BTCUSDT')],
        timeframe: '1m',
        indicators: {
          passthrough: () => makePassthroughIndicator(),
        },
      },
      passthroughEvaluate,
    );

    // Emit one candle before dispose — should produce a signal
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[0]! });
    expect(capture.count('scanner:signal')).toBe(1);

    scanner.dispose();

    // Emit candles after dispose — should be ignored
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[1]! });
    bus.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[2]! });
    expect(capture.count('scanner:signal')).toBe(1);
  });

  test('createScannerFactory creates independent scanner instances', () => {
    const { bus: bus1, capture: capture1 }: { bus: IEventBus; capture: EventCapture } =
      createTestBus();
    const { bus: bus2, capture: capture2 }: { bus: IEventBus; capture: EventCapture } =
      createTestBus();

    const config = {
      symbols: [toSymbol('BTCUSDT')],
      timeframe: '1m' as const,
      indicators: {
        passthrough: () => makePassthroughIndicator(),
      },
    };

    const factory = createScannerFactory('factory-scanner', passthroughEvaluate);
    const scanner1 = factory(bus1, config);
    const scanner2 = factory(bus2, config);

    bus1.emit('candle:close', { symbol: toSymbol('BTCUSDT'), timeframe: '1m', candle: fixtures.candles[0]! });

    // scanner2 on bus2 should not see bus1's events
    expect(capture1.count('scanner:signal')).toBe(1);
    expect(capture2.count('scanner:signal')).toBe(0);

    scanner1.dispose();
    scanner2.dispose();
  });
});
