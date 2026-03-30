import { describe, test, expect } from 'bun:test';

import {
  EventCapture,
  MockEventBus,
  createMockExchange,
  createMockExecutor,
  fixtures,
} from '@trading-bot/test-utils';
import type { IPositionManager, IRiskManager, IScanner, IScannerConfig, PositionState, Signal, StrategyConfig, StrategyDeps, SignalBuffer, SignalMerge } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { Strategy, passthroughMerge } from '../strategy';

const BASE_TIME = 1700000000000;

function makeScanner(name: string): IScanner & { disposeCount: number } {
  let disposeCount = 0;
  return {
    name,
    config: {
      symbols: [toSymbol('BTCUSDT')],
      timeframe: '1m',
      indicators: {},
    } satisfies IScannerConfig,
    dispose() {
      disposeCount++;
    },
    get disposeCount() {
      return disposeCount;
    },
  };
}

function makePositionManager(): IPositionManager & { disposeCount: number } {
  let disposeCount = 0;
  return {
    getState(_symbol: string): PositionState {
      return 'IDLE';
    },
    hasOpenPosition(_symbol: string): boolean {
      return false;
    },
    hasPendingOrder(_symbol: string): boolean {
      return false;
    },
    getOpenPositions() {
      return [];
    },
    resetAll() {},
    dispose() {
      disposeCount++;
    },
    get disposeCount() {
      return disposeCount;
    },
  };
}

function makeRiskManager(): IRiskManager & { disposeCount: number } {
  let disposeCount = 0;
  return {
    checkEntry(_signal: Signal, _entryPrice: number) {
      return { allowed: true, quantity: 0.1 } as const;
    },
    isKillSwitchActive() {
      return false;
    },
    reset() {},
    dispose() {
      disposeCount++;
    },
    get disposeCount() {
      return disposeCount;
    },
  };
}

function createTestBus() {
  const bus = new MockEventBus();
  const capture = new EventCapture(bus);
  return { bus, capture };
}

function makeDeps(bus: MockEventBus): StrategyDeps {
  return { bus, exchange: createMockExchange(), executor: createMockExecutor(bus) };
}

function makeStrategyConfig(overrides?: Partial<StrategyConfig>): StrategyConfig {
  return {
    name: 'test-strategy',
    symbols: [toSymbol('BTCUSDT')],
    scanners: [],
    signalMerge: passthroughMerge,
    signalBufferWindowMs: 5000,
    positionManager: makePositionManager(),
    riskManager: makeRiskManager(),
    ...overrides,
  };
}

describe('Strategy', () => {
  test('single scanner: scanner:signal → passthroughMerge → signal emitted', () => {
    const { bus, capture } = createTestBus();
    const config = makeStrategyConfig();
    const deps = makeDeps(bus);

    new Strategy(config, deps);

    bus.emit('scanner:signal', { signal: fixtures.longSignal });

    const signals = capture.get('signal');
    expect(signals.length).toBe(1);
    expect(signals[0]?.signal).toEqual(fixtures.longSignal);
  });

  test('merge returning null suppresses signal emission', () => {
    const { bus, capture } = createTestBus();
    const nullMerge: SignalMerge = () => null;
    const config = makeStrategyConfig({ signalMerge: nullMerge });
    const deps = makeDeps(bus);

    new Strategy(config, deps);
    bus.emit('scanner:signal', { signal: fixtures.longSignal });

    expect(capture.get('signal').length).toBe(0);
  });

  test('multi-scanner: merge only emits when both scanners agree', () => {
    const { bus, capture } = createTestBus();

    // Only emit when both 'scanner-a' and 'scanner-b' have signals in the buffer
    const requireBothMerge: SignalMerge = (trigger, buffer) => {
      const hasA = (buffer.get('scanner-a')?.length ?? 0) > 0;
      const hasB = (buffer.get('scanner-b')?.length ?? 0) > 0;
      return hasA && hasB ? trigger : null;
    };

    const config = makeStrategyConfig({ signalMerge: requireBothMerge });
    const deps = makeDeps(bus);
    new Strategy(config, deps);

    const signalA: Signal = {
      ...fixtures.longSignal,
      sourceScanner: 'scanner-a',
      timestamp: BASE_TIME,
    };
    const signalB: Signal = {
      ...fixtures.longSignal,
      sourceScanner: 'scanner-b',
      timestamp: BASE_TIME + 100,
    };

    // Only scanner-a fires — no emission
    bus.emit('scanner:signal', { signal: signalA });
    expect(capture.get('signal').length).toBe(0);

    // scanner-b fires — both in buffer, emit
    bus.emit('scanner:signal', { signal: signalB });
    expect(capture.get('signal').length).toBe(1);
  });

  test('buffer window: old signals are pruned before merge sees them', () => {
    const { bus, capture } = createTestBus();
    const windowMs = 1000;

    // Only emit when scanner-a is in the buffer (to verify pruning works)
    const requireOldMerge: SignalMerge = (trigger, buffer) => {
      const hasOld = (buffer.get('scanner-a')?.length ?? 0) > 0;
      return hasOld ? trigger : null;
    };

    const config = makeStrategyConfig({
      signalMerge: requireOldMerge,
      signalBufferWindowMs: windowMs,
    });
    const deps = makeDeps(bus);
    new Strategy(config, deps);

    const oldSignal: Signal = {
      ...fixtures.longSignal,
      sourceScanner: 'scanner-a',
      timestamp: BASE_TIME,
    };
    // New signal is far outside the window relative to the old one
    const newSignal: Signal = {
      ...fixtures.longSignal,
      sourceScanner: 'scanner-b',
      timestamp: BASE_TIME + windowMs + 1,
    };

    bus.emit('scanner:signal', { signal: oldSignal });
    // At this point scanner-a is in buffer, merge would pass
    expect(capture.get('signal').length).toBe(1);

    // Reset capture count — emit new signal which should prune scanner-a
    // (scanner-a timestamp is older than windowStart = BASE_TIME + windowMs + 1 - windowMs = BASE_TIME + 1)
    bus.emit('scanner:signal', { signal: newSignal });
    // scanner-a should be pruned; requireOldMerge sees no scanner-a → no new signal
    expect(capture.get('signal').length).toBe(1); // still just 1
  });

  test('stop() calls dispose() on all scanners, positionManager, and riskManager', async () => {
    const { bus } = createTestBus();
    const scanner1 = makeScanner('scanner-1');
    const scanner2 = makeScanner('scanner-2');
    const positionManager = makePositionManager();
    const riskManager = makeRiskManager();

    const config = makeStrategyConfig({
      scanners: [scanner1, scanner2],
      positionManager,
      riskManager,
    });
    const deps = makeDeps(bus);
    const strategy = new Strategy(config, deps);

    await strategy.stop();

    expect(scanner1.disposeCount).toBe(1);
    expect(scanner2.disposeCount).toBe(1);
    expect(positionManager.disposeCount).toBe(1);
    expect(riskManager.disposeCount).toBe(1);
  });

  test('stop() unsubscribes from scanner:signal — no signal emitted after stop', async () => {
    const { bus, capture } = createTestBus();
    const config = makeStrategyConfig();
    const deps = makeDeps(bus);
    const strategy = new Strategy(config, deps);

    await strategy.stop();
    bus.emit('scanner:signal', { signal: fixtures.longSignal });

    expect(capture.get('signal').length).toBe(0);
  });

  test('getStats() returns zeroed PerformanceMetrics', () => {
    const { bus } = createTestBus();
    const config = makeStrategyConfig();
    const deps = makeDeps(bus);
    const strategy = new Strategy(config, deps);

    const stats = strategy.getStats();
    expect(stats.totalTrades).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.profitFactor).toBe(0);
    expect(stats.sharpeRatio).toBe(0);
    expect(stats.maxDrawdown).toBe(0);
    expect(stats.maxDrawdownDuration).toBe(0);
    expect(stats.avgWin).toBe(0);
    expect(stats.avgLoss).toBe(0);
    expect(stats.expectancy).toBe(0);
    expect(stats.avgHoldTime).toBe(0);
    expect(stats.totalFees).toBe(0);
    expect(stats.totalSlippage).toBe(0);
  });

  test('passthroughMerge returns the trigger signal unchanged', () => {
    const signal: Signal = fixtures.longSignal;
    const result = passthroughMerge(signal, new Map());
    expect(result).toBe(signal);
  });

  test('buffer accumulates multiple signals per scanner across emissions', () => {
    const { bus } = createTestBus();
    const captured: SignalBuffer[] = [];

    const captureMerge: SignalMerge = (trigger, buffer) => {
      captured.push(new Map(Array.from(buffer.entries()).map(([k, v]) => [k, [...v]])));
      return trigger;
    };

    const config = makeStrategyConfig({
      signalMerge: captureMerge,
      signalBufferWindowMs: 10000,
    });
    const deps = makeDeps(bus);
    new Strategy(config, deps);

    const s1: Signal = { ...fixtures.longSignal, sourceScanner: 'sc', timestamp: BASE_TIME };
    const s2: Signal = { ...fixtures.longSignal, sourceScanner: 'sc', timestamp: BASE_TIME + 100 };

    bus.emit('scanner:signal', { signal: s1 });
    bus.emit('scanner:signal', { signal: s2 });

    expect(captured[0]?.get('sc')?.length).toBe(1);
    expect(captured[1]?.get('sc')?.length).toBe(2);
  });
});
