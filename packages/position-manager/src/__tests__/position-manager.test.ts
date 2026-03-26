import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createTestBus,
  createMockExecutor,
  EventCapture,
  fixtures,
} from '@trading-bot/test-utils';
import type { IEventBus } from '@trading-bot/event-bus';
import type { IOrderExecutor } from '@trading-bot/order-executor';
import type { IRiskManager } from '@trading-bot/risk-manager';
import type { OrderRequest, Signal, SubmissionReceipt } from '@trading-bot/types';
import { PositionManager } from '../position-manager';
import type { PositionManagerConfig, PositionState } from '../index';

// ── typed aliases for fixtures — prevents no-unsafe-argument errors ───────────
const LONG_SIGNAL: Signal = fixtures.longSignal;
const SHORT_SIGNAL: Signal = fixtures.shortSignal;
const DEFAULT_PM_CONFIG: PositionManagerConfig = fixtures.defaultPositionManagerConfig;

// ── constants ─────────────────────────────────────────────────────────────────
const SYMBOL = 'BTCUSDT';
const ENTRY_PRICE = 50000;

// ── helpers ───────────────────────────────────────────────────────────────────
function makeMockRiskManager(allowed = true, quantity = 0.1): IRiskManager {
  return {
    checkEntry: () =>
      allowed
        ? { allowed: true, quantity }
        : { allowed: false, rule: 'MAX_CONCURRENT', reason: 'test', severity: 'REJECT' },
    isKillSwitchActive: () => false,
    reset: () => {},
    dispose: () => {},
  };
}

function makeConfig(overrides?: Partial<PositionManagerConfig>): PositionManagerConfig {
  const base: PositionManagerConfig = DEFAULT_PM_CONFIG;
  return { ...base, ...overrides };
}

// ── setup ─────────────────────────────────────────────────────────────────────
let bus: IEventBus;
let capture: EventCapture;
let syncExecutor: IOrderExecutor;

beforeEach(() => {
  ({ bus, capture } = createTestBus());
  syncExecutor = createMockExecutor(bus, { syncFill: true, fillPrice: ENTRY_PRICE });
});

// ── tests ─────────────────────────────────────────────────────────────────────
describe('PositionManager', () => {
  test('package is importable', async () => {
    const mod = await import('../index');
    expect(mod).toBeDefined();
  });

  test('PositionState type is correct', () => {
    const state: PositionState = 'IDLE';
    expect(state).toBe('IDLE');
  });

  // ─── Test 1: Full entry flow ─────────────────────────────────────────────
  describe('full entry flow', () => {
    test('signal → checkEntry → order:submitted + order:filled → state OPEN, position:opened emitted', () => {
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, makeConfig());

      expect(pm.getState(SYMBOL)).toBe('IDLE');

      bus.emit('signal', { signal: LONG_SIGNAL });

      expect(capture.count('order:submitted')).toBe(1);
      expect(capture.count('order:filled')).toBe(1);
      expect(capture.count('position:opened')).toBe(1);
      expect(pm.getState(SYMBOL)).toBe('OPEN');
      expect(pm.hasOpenPosition(SYMBOL)).toBe(true);

      const posOpened = capture.last('position:opened');
      expect(posOpened?.position.symbol).toBe(SYMBOL);
      expect(posOpened?.position.side).toBe('LONG');

      pm.dispose();
    });
  });

  // ─── Test 2: Full exit via SL tick ───────────────────────────────────────
  describe('full exit flow via SL tick', () => {
    test('tick below stop price → exit order submitted and filled → state IDLE, position:closed emitted with TradeRecord', () => {
      const config = makeConfig({ defaultStopLossPct: 2 });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, config);

      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(pm.getState(SYMBOL)).toBe('OPEN');
      capture.clear();

      const stopPrice = ENTRY_PRICE * (1 - config.defaultStopLossPct / 100);
      const timestamp: number = fixtures.tick.timestamp;
      bus.emit('tick', {
        symbol: SYMBOL,
        tick: {
          symbol: SYMBOL,
          price: stopPrice - 10,
          quantity: 1,
          timestamp: timestamp + 1000,
          isBuyerMaker: false,
        },
      });

      expect(capture.count('order:submitted')).toBe(1);
      expect(capture.count('order:filled')).toBe(1);
      expect(capture.count('position:closed')).toBe(1);
      expect(pm.getState(SYMBOL)).toBe('IDLE');

      const closedEvent = capture.last('position:closed');
      expect(closedEvent?.trade).toBeDefined();
      expect(closedEvent?.trade.exitReason).toBe('STOP_LOSS');
      expect(closedEvent?.trade.symbol).toBe(SYMBOL);
      expect(typeof closedEvent?.trade.pnl).toBe('number');

      pm.dispose();
    });
  });

  // ─── Test 3: SL hit on candle:close (backtest path) ──────────────────────
  describe('candle:close SL hit', () => {
    test('candle low <= stopPrice triggers stop loss exit for LONG', () => {
      const config = makeConfig({ defaultStopLossPct: 2 });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, config);

      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(pm.getState(SYMBOL)).toBe('OPEN');
      capture.clear();

      const stopPrice = ENTRY_PRICE * (1 - config.defaultStopLossPct / 100);
      const baseCandle = fixtures.candle;
      bus.emit('candle:close', {
        symbol: SYMBOL,
        timeframe: '1m',
        candle: {
          ...baseCandle,
          openTime: baseCandle.openTime + 60000,
          closeTime: baseCandle.closeTime + 60000,
          open: ENTRY_PRICE,
          high: ENTRY_PRICE + 100,
          low: stopPrice - 50,
          close: ENTRY_PRICE - 200,
        },
      });

      expect(capture.count('position:closed')).toBe(1);
      expect(capture.last('position:closed')?.trade.exitReason).toBe('STOP_LOSS');
      expect(pm.getState(SYMBOL)).toBe('IDLE');

      pm.dispose();
    });
  });

  // ─── Test 4: TP hit on candle:close ──────────────────────────────────────
  describe('candle:close TP hit', () => {
    test('candle high >= takeProfitPrice triggers take profit exit for LONG', () => {
      const config = makeConfig({ defaultTakeProfitPct: 4 });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, config);

      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(pm.getState(SYMBOL)).toBe('OPEN');
      capture.clear();

      const tpPrice = ENTRY_PRICE * (1 + config.defaultTakeProfitPct / 100);
      const baseCandle = fixtures.candle;
      bus.emit('candle:close', {
        symbol: SYMBOL,
        timeframe: '1m',
        candle: {
          ...baseCandle,
          openTime: baseCandle.openTime + 60000,
          closeTime: baseCandle.closeTime + 60000,
          open: ENTRY_PRICE,
          high: tpPrice + 100,
          low: ENTRY_PRICE - 10,
          close: tpPrice + 50,
        },
      });

      expect(capture.count('position:closed')).toBe(1);
      expect(capture.last('position:closed')?.trade.exitReason).toBe('TAKE_PROFIT');
      expect(pm.getState(SYMBOL)).toBe('IDLE');

      pm.dispose();
    });
  });

  // ─── Test 5: SL + TP both hit in same candle → SL wins ───────────────────
  describe('SL + TP tiebreak', () => {
    test('when both SL and TP hit in same candle, SL wins', () => {
      const config = makeConfig({ defaultStopLossPct: 2, defaultTakeProfitPct: 4 });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, config);

      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(pm.getState(SYMBOL)).toBe('OPEN');
      capture.clear();

      const stopPrice = ENTRY_PRICE * (1 - config.defaultStopLossPct / 100);
      const tpPrice = ENTRY_PRICE * (1 + config.defaultTakeProfitPct / 100);
      const baseCandle = fixtures.candle;
      bus.emit('candle:close', {
        symbol: SYMBOL,
        timeframe: '1m',
        candle: {
          ...baseCandle,
          openTime: baseCandle.openTime + 60000,
          closeTime: baseCandle.closeTime + 60000,
          open: ENTRY_PRICE,
          high: tpPrice + 100,
          low: stopPrice - 50,
          close: ENTRY_PRICE,
        },
      });

      expect(capture.count('position:closed')).toBe(1);
      expect(capture.last('position:closed')?.trade.exitReason).toBe('STOP_LOSS');

      pm.dispose();
    });
  });

  // ─── Test 6: Duplicate signal while PENDING_ENTRY → ignored ──────────────
  describe('duplicate signal protection', () => {
    test('signal while PENDING_ENTRY is ignored', () => {
      const asyncExecutor: IOrderExecutor = createMockExecutor(bus, { syncFill: false });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, asyncExecutor, riskMgr, makeConfig());

      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(pm.getState(SYMBOL)).toBe('PENDING_ENTRY');

      const firstSubmitCount = capture.count('order:submitted');

      bus.emit('signal', { signal: LONG_SIGNAL });

      expect(capture.count('order:submitted')).toBe(firstSubmitCount);

      pm.dispose();
    });
  });

  // ─── Test 7: order:rejected while PENDING_ENTRY → state back to IDLE ─────
  describe('order:rejected reverts state', () => {
    test('rejected entry order reverts state to IDLE', () => {
      const rejectExecutor: IOrderExecutor = createMockExecutor(bus, { syncFill: true, rejectAll: true });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, rejectExecutor, riskMgr, makeConfig());

      expect(pm.getState(SYMBOL)).toBe('IDLE');
      bus.emit('signal', { signal: LONG_SIGNAL });

      expect(pm.getState(SYMBOL)).toBe('IDLE');

      pm.dispose();
    });
  });

  // ─── Test 8: Risk check rejected → no order, state stays IDLE ────────────
  describe('risk check rejected', () => {
    test('when risk manager rejects, no order is submitted and state stays IDLE', () => {
      const riskMgr = makeMockRiskManager(false);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, makeConfig());

      bus.emit('signal', { signal: LONG_SIGNAL });

      expect(capture.count('order:submitted')).toBe(0);
      expect(pm.getState(SYMBOL)).toBe('IDLE');

      pm.dispose();
    });
  });

  // ─── Test 9: Risk check KILL → risk:breach emitted ───────────────────────
  describe('risk check KILL severity', () => {
    test('when risk manager returns KILL severity, risk:breach event is emitted', () => {
      const killRiskMgr: IRiskManager = {
        checkEntry: () => ({
          allowed: false,
          rule: 'MAX_DAILY_LOSS',
          reason: 'daily loss exceeded',
          severity: 'KILL',
        }),
        isKillSwitchActive: () => true,
        reset: () => {},
        dispose: () => {},
      };
      const pm = new PositionManager(bus, syncExecutor, killRiskMgr, makeConfig());

      bus.emit('signal', { signal: LONG_SIGNAL });

      expect(capture.count('risk:breach')).toBe(1);
      const breach = capture.last('risk:breach');
      expect(breach?.rule).toBe('MAX_DAILY_LOSS');
      expect(breach?.severity).toBe('KILL');
      expect(pm.getState(SYMBOL)).toBe('IDLE');

      pm.dispose();
    });
  });

  // ─── Test 10: dispose() → events after dispose don't change state ─────────
  describe('dispose()', () => {
    test('after dispose, emitted events do not change state', () => {
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, makeConfig());

      pm.dispose();

      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(pm.getState(SYMBOL)).toBe('IDLE');
    });
  });

  // ─── Additional: trailing stop ────────────────────────────────────────────
  describe('trailing stop', () => {
    test('trailing stop activates and triggers exit when price drops from peak', () => {
      const config = makeConfig({
        trailingStopEnabled: true,
        trailingStopActivationPct: 1,
        trailingStopDistancePct: 0.5,
        defaultStopLossPct: 10,
        defaultTakeProfitPct: 20,
      });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, config);

      const trailSignal: Signal = { ...LONG_SIGNAL, price: ENTRY_PRICE };
      bus.emit('signal', { signal: trailSignal });
      expect(pm.getState(SYMBOL)).toBe('OPEN');
      capture.clear();

      const baseTimestamp: number = fixtures.tick.timestamp + 1000;

      const peakPrice = ENTRY_PRICE * 1.015;
      bus.emit('tick', {
        symbol: SYMBOL,
        tick: { symbol: SYMBOL, price: peakPrice, quantity: 1, timestamp: baseTimestamp, isBuyerMaker: false },
      });

      const dropPrice = peakPrice * (1 - 0.006);
      bus.emit('tick', {
        symbol: SYMBOL,
        tick: { symbol: SYMBOL, price: dropPrice, quantity: 1, timestamp: baseTimestamp + 1000, isBuyerMaker: false },
      });

      expect(capture.count('position:closed')).toBe(1);
      expect(capture.last('position:closed')?.trade.exitReason).toBe('TRAILING_STOP');

      pm.dispose();
    });
  });

  // ─── Additional: timeout exit ─────────────────────────────────────────────
  describe('timeout exit', () => {
    test('TIMEOUT exit triggered when maxHoldTimeMs exceeded', () => {
      const config = makeConfig({ maxHoldTimeMs: 5000 });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, config);

      const entryTimestamp: number = LONG_SIGNAL.timestamp;
      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(pm.getState(SYMBOL)).toBe('OPEN');
      capture.clear();

      bus.emit('tick', {
        symbol: SYMBOL,
        tick: {
          symbol: SYMBOL,
          price: ENTRY_PRICE,
          quantity: 1,
          timestamp: entryTimestamp + 6000,
          isBuyerMaker: false,
        },
      });

      expect(capture.count('position:closed')).toBe(1);
      expect(capture.last('position:closed')?.trade.exitReason).toBe('TIMEOUT');

      pm.dispose();
    });
  });

  // ─── Additional: order:rejected while PENDING_EXIT reverts to OPEN ────────
  describe('order:rejected while PENDING_EXIT', () => {
    test('rejected exit order reverts state back to OPEN', () => {
      let fillCount = 0;
      const mockExecutor: IOrderExecutor = {
        submit(request: OrderRequest): SubmissionReceipt {
          fillCount++;
          const clientOrderId = request.clientOrderId ?? `mock-${String(fillCount)}`;
          const receipt: SubmissionReceipt = {
            clientOrderId,
            symbol: request.symbol,
            side: request.side,
            type: request.type,
            quantity: request.quantity,
            submittedAt: Date.now(),
          };

          bus.emit('order:submitted', { receipt });

          if (fillCount === 1) {
            bus.emit('order:filled', {
              order: {
                orderId: `fill-${String(fillCount)}`,
                clientOrderId,
                symbol: request.symbol,
                side: request.side,
                type: request.type,
                status: 'FILLED',
                price: ENTRY_PRICE,
                avgPrice: ENTRY_PRICE,
                quantity: request.quantity,
                filledQuantity: request.quantity,
                commission: 0,
                commissionAsset: 'USDT',
                timestamp: Date.now(),
                latencyMs: 0,
              },
            });
          } else {
            bus.emit('order:rejected', { clientOrderId, reason: 'Exchange error' });
          }

          return receipt;
        },
        cancelAll: () => {},
        hasPending: () => false,
        getPendingCount: () => 0,
        start: async (): Promise<void> => {},
        stop: async (): Promise<void> => {},
      };

      const riskMgr = makeMockRiskManager(true, 0.1);
      const config = makeConfig({ defaultStopLossPct: 2 });
      const pm = new PositionManager(bus, mockExecutor, riskMgr, config);

      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(pm.getState(SYMBOL)).toBe('OPEN');

      const stopPrice = ENTRY_PRICE * (1 - config.defaultStopLossPct / 100);
      const tickTimestamp: number = fixtures.tick.timestamp;
      bus.emit('tick', {
        symbol: SYMBOL,
        tick: {
          symbol: SYMBOL,
          price: stopPrice - 10,
          quantity: 1,
          timestamp: tickTimestamp + 1000,
          isBuyerMaker: false,
        },
      });

      expect(pm.getState(SYMBOL)).toBe('OPEN');

      pm.dispose();
    });
  });

  // ─── Additional: SHORT position ───────────────────────────────────────────
  describe('SHORT position entry', () => {
    test('ENTER_SHORT signal creates a SHORT position', () => {
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, makeConfig());

      bus.emit('signal', { signal: SHORT_SIGNAL });

      expect(pm.getState(SYMBOL)).toBe('OPEN');
      const posOpened = capture.last('position:opened');
      expect(posOpened?.position.side).toBe('SHORT');

      pm.dispose();
    });
  });

  // ─── Additional: getOpenPositions ─────────────────────────────────────────
  describe('getOpenPositions()', () => {
    test('returns all symbols in OPEN state as Position[]', () => {
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, makeConfig());

      expect(pm.getOpenPositions()).toHaveLength(0);

      bus.emit('signal', { signal: LONG_SIGNAL });

      const openPositions = pm.getOpenPositions();
      expect(openPositions).toHaveLength(1);
      expect(openPositions[0]?.symbol).toBe(SYMBOL);

      pm.dispose();
    });

    test('multiple symbols tracked independently', () => {
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, makeConfig());

      const ethSignal: Signal = { ...LONG_SIGNAL, symbol: 'ETHUSDT' };

      bus.emit('signal', { signal: LONG_SIGNAL });
      bus.emit('signal', { signal: ethSignal });

      expect(pm.getOpenPositions()).toHaveLength(2);
      expect(pm.hasOpenPosition(SYMBOL)).toBe(true);
      expect(pm.hasOpenPosition('ETHUSDT')).toBe(true);

      pm.dispose();
    });
  });

  // ─── Additional: hasPendingOrder ──────────────────────────────────────────
  describe('hasPendingOrder()', () => {
    test('returns true when PENDING_ENTRY', () => {
      const asyncExecutor: IOrderExecutor = createMockExecutor(bus, { syncFill: false });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, asyncExecutor, riskMgr, makeConfig());

      bus.emit('signal', { signal: LONG_SIGNAL });

      expect(pm.hasPendingOrder(SYMBOL)).toBe(true);
      expect(pm.getState(SYMBOL)).toBe('PENDING_ENTRY');

      pm.dispose();
    });
  });

  // ─── Additional: EventCapture integration ─────────────────────────────────
  describe('EventCapture integration', () => {
    test('EventCapture records all expected events during full trade lifecycle', () => {
      const config = makeConfig({ defaultStopLossPct: 2 });
      const riskMgr = makeMockRiskManager(true, 0.1);
      const pm = new PositionManager(bus, syncExecutor, riskMgr, config);

      bus.emit('signal', { signal: LONG_SIGNAL });
      expect(capture.count('order:submitted')).toBe(1);
      expect(capture.count('order:filled')).toBe(1);
      expect(capture.count('position:opened')).toBe(1);

      const stopPrice = ENTRY_PRICE * (1 - config.defaultStopLossPct / 100);
      const tickTimestamp: number = fixtures.tick.timestamp;
      bus.emit('tick', {
        symbol: SYMBOL,
        tick: {
          symbol: SYMBOL,
          price: stopPrice - 1,
          quantity: 1,
          timestamp: tickTimestamp + 1000,
          isBuyerMaker: false,
        },
      });

      expect(capture.count('order:submitted')).toBe(2);
      expect(capture.count('order:filled')).toBe(2);
      expect(capture.count('position:closed')).toBe(1);

      const trade = capture.last('position:closed')?.trade;
      expect(trade).toBeDefined();
      expect(trade?.id).toBeDefined();
      expect(trade?.fees).toBeGreaterThanOrEqual(0);
      expect(trade?.holdTimeMs).toBeGreaterThanOrEqual(0);

      pm.dispose();
    });
  });
});
