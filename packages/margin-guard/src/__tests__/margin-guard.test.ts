import { describe, test, expect, beforeEach } from 'bun:test';

import { createTestBus, EventCapture, fixtures } from '@trading-bot/test-utils';
import type { IEventBus, Position } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { MarginGuard } from '../margin-guard';
import type { MarginGuardConfig } from '../types';

// ── constants ──────────────────────────────────────────────────────────────────

const BASE_TIME = 1700000000000;

const DEFAULT_CONFIG: MarginGuardConfig = {
  maxUnrealizedLossPct: 10,
  maxTotalExposurePct: 2000, // high default so exposure doesn't trigger in most tests (accounts for leverage)
  evaluationEvent: 'tick',
  balance: 10000,
};

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    symbol: toSymbol('BTCUSDT'),
    side: 'LONG',
    entryPrice: 50000,
    quantity: 0.1,
    unrealizedPnl: 0,
    leverage: 10,
    liquidationPrice: 45000,
    marginType: 'ISOLATED',
    timestamp: BASE_TIME,
    ...overrides,
  };
}

// ── setup ─────────────────────────────────────────────────────────────────────

let bus: IEventBus;
let capture: EventCapture;
let guard: MarginGuard;

beforeEach(() => {
  ({ bus, capture } = createTestBus());
  guard = new MarginGuard(bus, DEFAULT_CONFIG);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('MarginGuard', () => {
  // 1. Unrealized loss threshold triggers breach
  test('triggers breach when unrealized loss exceeds threshold', () => {
    // Open a LONG position at 50000, qty 0.1
    bus.emit('position:opened', { position: makePosition() });

    // Price drops to 39000 → unrealized PnL = (39000 - 50000) * 1 * 0.1 = -1100
    // -1100 / 10000 * 100 = -11% → exceeds -10% threshold
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 39000 },
    });

    expect(guard.isBreached).toBe(true);
    expect(capture.count('risk:breach')).toBe(1);
    const breach = capture.last('risk:breach');
    expect(breach?.rule).toBe('MAX_DRAWDOWN');
    expect(breach?.severity).toBe('KILL');
  });

  // 2. Total exposure threshold triggers breach
  test('triggers breach when total exposure exceeds threshold', () => {
    // Open a position at 50000, qty 0.1 — notional = 50000 * 0.1 = 5000
    // Exposure = 5000 / 10000 * 100 = 50% — right at threshold
    // Need mark price slightly above to push over
    guard.dispose();
    const config: MarginGuardConfig = {
      ...DEFAULT_CONFIG,
      maxTotalExposurePct: 50,
    };
    guard = new MarginGuard(bus, config);

    bus.emit('position:opened', { position: makePosition() });

    // markPrice = 50100 → notional = 50100 * 0.1 = 5010
    // 5010 / 10000 * 100 = 50.1% >= 50% → breach
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 50100 },
    });

    expect(guard.isBreached).toBe(true);
    expect(capture.count('risk:breach')).toBe(1);
    const breach = capture.last('risk:breach');
    expect(breach?.severity).toBe('KILL');
  });

  // 3. Breach emits risk:breach event on the bus
  test('emits risk:breach event with correct payload', () => {
    bus.emit('position:opened', { position: makePosition() });

    // Trigger unrealized loss breach
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 39000 },
    });

    const events = capture.get('risk:breach');
    expect(events.length).toBe(1);
    expect(events[0]?.rule).toBe('MAX_DRAWDOWN');
    expect(events[0]?.severity).toBe('KILL');
    expect(events[0]?.message).toContain('Unrealized loss');
  });

  // 4. Position tracking — opened and closed
  test('tracks positions through opened and closed events', () => {
    const pos = makePosition();

    bus.emit('position:opened', { position: pos });

    // Price at entry — no breach
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 50000 },
    });
    expect(guard.isBreached).toBe(false);

    // Close the position
    bus.emit('position:closed', {
      position: pos,
      trade: {
        id: 'trade-1',
        symbol: toSymbol('BTCUSDT'),
        side: 'LONG',
        entryPrice: 50000,
        exitPrice: 49000,
        quantity: 0.1,
        entryTime: BASE_TIME,
        exitTime: BASE_TIME + 3600000,
        pnl: -100,
        fees: 2,
        slippage: 0,
        holdTimeMs: 3600000,
        exitReason: 'STOP_LOSS',
        metadata: {},
      },
    });

    // Even with a very low price, no breach — position was closed
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 1000 },
    });
    expect(guard.isBreached).toBe(false);
  });

  // 5. isBreached stays true once triggered (latched)
  test('isBreached stays true once triggered (latched)', () => {
    bus.emit('position:opened', { position: makePosition() });

    // Trigger breach
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 39000 },
    });
    expect(guard.isBreached).toBe(true);

    // Price recovers — still breached
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 55000 },
    });
    expect(guard.isBreached).toBe(true);

    // Only one risk:breach event emitted (no duplicate)
    expect(capture.count('risk:breach')).toBe(1);
  });

  // 6. Tick-based evaluation
  test('evaluates on tick events when configured for tick', () => {
    guard = new MarginGuard(bus, { ...DEFAULT_CONFIG, evaluationEvent: 'tick' });

    bus.emit('position:opened', { position: makePosition() });

    // No breach with a benign price
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 49500 },
    });
    expect(guard.isBreached).toBe(false);

    // Breach with a bad price
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 39000 },
    });
    expect(guard.isBreached).toBe(true);
  });

  // 7. candle:close-based evaluation
  test('evaluates on candle:close events when configured for candle:close', () => {
    guard = new MarginGuard(bus, { ...DEFAULT_CONFIG, evaluationEvent: 'candle:close' });

    bus.emit('position:opened', { position: makePosition() });

    // Tick events should NOT trigger evaluation (subscribed to candle:close)
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 39000 },
    });
    expect(guard.isBreached).toBe(false);

    // Candle close with a bad price triggers breach
    bus.emit('candle:close', {
      symbol: toSymbol('BTCUSDT'),
      timeframe: '1m',
      candle: { ...fixtures.candle, close: 39000 },
    });
    expect(guard.isBreached).toBe(true);
  });

  // 8. dispose() stops evaluation
  test('dispose() stops evaluation — no breach after dispose', () => {
    bus.emit('position:opened', { position: makePosition() });

    guard.dispose();

    // Bad price arrives after dispose — should NOT trigger breach
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 39000 },
    });
    expect(guard.isBreached).toBe(false);
    expect(capture.count('risk:breach')).toBe(0);
  });

  // 9. No breach when loss is within threshold
  test('no breach when unrealized loss is within threshold', () => {
    bus.emit('position:opened', { position: makePosition() });

    // Price drops to 45000 → PnL = (45000-50000)*0.1 = -500 → -5% (within -10%)
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 45000 },
    });
    expect(guard.isBreached).toBe(false);
    expect(capture.count('risk:breach')).toBe(0);
  });

  // 10. Multiple positions aggregate correctly
  test('aggregates unrealized PnL across multiple positions', () => {
    // Two LONG positions, each qty 0.1, entry 50000
    bus.emit('position:opened', { position: makePosition() });
    bus.emit('position:opened', { position: makePosition() });

    // Price drops to 45000 → each PnL = -500, total = -1000 → -10% exactly at threshold
    // <= -10% → breach
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 45000 },
    });
    expect(guard.isBreached).toBe(true);
  });

  // 11. SHORT position unrealized PnL computed correctly
  test('SHORT position unrealized PnL computed correctly', () => {
    bus.emit('position:opened', {
      position: makePosition({ side: 'SHORT', entryPrice: 50000, quantity: 0.1 }),
    });

    // Price rises to 61000 → PnL = (61000-50000) * -1 * 0.1 = -1100 → -11%
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 61000 },
    });
    expect(guard.isBreached).toBe(true);
  });

  // 12. Exposure breach message contains correct info
  test('exposure breach message mentions exposure', () => {
    const config: MarginGuardConfig = {
      ...DEFAULT_CONFIG,
      maxTotalExposurePct: 40,
    };
    guard = new MarginGuard(bus, config);

    bus.emit('position:opened', { position: makePosition() });

    // notional = 50000 * 0.1 = 5000 → 50% >= 40%
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, price: 50000 },
    });

    expect(guard.isBreached).toBe(true);
    const breach = capture.last('risk:breach');
    expect(breach?.message).toContain('exposure');
  });

  // 13. Positions across multiple symbols
  test('tracks positions across multiple symbols', () => {
    bus.emit('position:opened', {
      position: makePosition({ symbol: toSymbol('BTCUSDT'), entryPrice: 50000, quantity: 0.05 }),
    });
    bus.emit('position:opened', {
      position: makePosition({ symbol: toSymbol('ETHUSDT'), entryPrice: 3000, quantity: 1.0 }),
    });

    // BTC stays flat, ETH drops heavily
    bus.emit('tick', {
      symbol: toSymbol('BTCUSDT'),
      tick: { ...fixtures.tick, symbol: toSymbol('BTCUSDT'), price: 50000 },
    });
    expect(guard.isBreached).toBe(false);

    // ETH drops: PnL = (1800-3000)*1*1.0 = -1200 → total = 0 + (-1200) = -1200 → -12% > 10%
    bus.emit('tick', {
      symbol: toSymbol('ETHUSDT'),
      tick: { ...fixtures.tick, symbol: toSymbol('ETHUSDT'), price: 1800 },
    });
    expect(guard.isBreached).toBe(true);
  });
});
