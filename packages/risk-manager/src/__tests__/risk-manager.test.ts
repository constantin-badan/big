import { describe, test, expect, beforeEach } from 'bun:test';

import { createTestBus, fixtures } from '@trading-bot/test-utils';
import type { IEventBus, RiskCheckResult, Signal, TradeRecord } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { RiskManager } from '../risk-manager';
import type { RiskConfig } from '../types';

// ── constants ──────────────────────────────────────────────────────────────────

const BASE_TIME = 1700000000000; // same as fixtures

/** UTC midnight boundary that falls strictly after BASE_TIME */
const NEXT_DAY_TIME = (Math.floor(BASE_TIME / 86_400_000) + 1) * 86_400_000 + 1000;

// Typed aliases for fixture values — eliminates no-unsafe-argument lint errors
const LONG_SIGNAL: Signal = fixtures.longSignal;
const DEFAULT_CONFIG: RiskConfig = fixtures.defaultRiskConfig;

// ── helpers ────────────────────────────────────────────────────────────────────

function makeSignal(timestamp: number): Signal {
  return {
    symbol: toSymbol('BTCUSDT'),
    action: 'ENTER_LONG',
    confidence: 0.85,
    price: 50020,
    timestamp,
    sourceScanner: 'test-scanner',
    metadata: {},
  };
}

function makeTrade(pnl: number, exitTime = BASE_TIME + 3600000): TradeRecord {
  return {
    id: `trade-${exitTime}-${pnl}`,
    symbol: toSymbol('BTCUSDT'),
    side: 'LONG',
    entryPrice: 50000,
    exitPrice: 51000,
    quantity: 0.1,
    entryTime: BASE_TIME,
    exitTime,
    pnl,
    fees: 2,
    slippage: 0,
    holdTimeMs: 3600000,
    exitReason: 'TAKE_PROFIT',
    metadata: {},
  };
}

// ── setup ─────────────────────────────────────────────────────────────────────

let bus: IEventBus;
let riskManager: RiskManager;

// DEFAULT_CONFIG:
// { maxPositionSizePct:5, maxConcurrentPositions:3, maxDailyLossPct:2,
//   maxDrawdownPct:10, maxDailyTrades:20, cooldownAfterLossMs:60000,
//   leverage:1, initialBalance:10000 }

beforeEach(() => {
  ({ bus } = createTestBus());
  riskManager = new RiskManager(bus, DEFAULT_CONFIG);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('RiskManager', () => {
  // 1. Fresh state + valid signal → allowed: true with correct quantity
  test('fresh state + valid signal → allowed with correct quantity', () => {
    const result: RiskCheckResult = riskManager.checkEntry(LONG_SIGNAL, 50020);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // quantity = (10000 * 0.05 * 1) / 50020 ≈ 0.009992...
      const expected = (10000 * 0.05 * 1) / 50020;
      expect(result.quantity).toBeCloseTo(expected, 8);
    }
  });

  // 2. Max concurrent positions hit → REJECT with MAX_CONCURRENT
  test('max concurrent positions hit → REJECT MAX_CONCURRENT', () => {
    for (let i = 0; i < DEFAULT_CONFIG.maxConcurrentPositions; i++) {
      bus.emit('position:opened', { position: fixtures.openLong });
    }

    const result = riskManager.checkEntry(LONG_SIGNAL, 50020);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rule).toBe('MAX_CONCURRENT');
      expect(result.severity).toBe('REJECT');
    }
  });

  // 3. Max daily trades hit → REJECT with MAX_DAILY_TRADES
  test('max daily trades hit → REJECT MAX_DAILY_TRADES', () => {
    for (let i = 0; i < DEFAULT_CONFIG.maxDailyTrades; i++) {
      bus.emit('order:filled', {
        order: { ...fixtures.filledBuy, timestamp: BASE_TIME + i },
      });
    }

    const result = riskManager.checkEntry(LONG_SIGNAL, 50020);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rule).toBe('MAX_DAILY_TRADES');
      expect(result.severity).toBe('REJECT');
    }
  });

  // 4. Cooldown after losing trade → REJECT with COOLDOWN
  test('cooldown after losing trade → REJECT COOLDOWN', () => {
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-100, BASE_TIME),
    });

    // Signal arrives 30 seconds later (< cooldownAfterLossMs = 60_000)
    const signal = makeSignal(BASE_TIME + 30000);
    const result = riskManager.checkEntry(signal, 50020);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rule).toBe('COOLDOWN');
      expect(result.severity).toBe('REJECT');
    }
  });

  // 5. No cooldown after winning trade
  test('no cooldown after winning trade', () => {
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(100, BASE_TIME),
    });

    // Signal arrives 30 seconds later — but trade was profitable → no cooldown
    const signal = makeSignal(BASE_TIME + 30000);
    const result = riskManager.checkEntry(signal, 50020);
    expect(result.allowed).toBe(true);
  });

  // 6. Max daily loss hit → KILL, isKillSwitchActive() === true
  test('max daily loss hit → KILL MAX_DAILY_LOSS, kill switch active', () => {
    // maxDailyLossPct = 2 → daily loss threshold = -(10000 * 2 / 100) = -200
    // Lose -201 (exceeds threshold)
    const tradeTime = BASE_TIME + 3600000;
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-201, tradeTime),
    });

    // Signal arrives after the cooldown window to avoid COOLDOWN rule firing first
    const signal = makeSignal(tradeTime + DEFAULT_CONFIG.cooldownAfterLossMs + 1000);
    const result = riskManager.checkEntry(signal, 50020);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rule).toBe('MAX_DAILY_LOSS');
      expect(result.severity).toBe('KILL');
    }
    expect(riskManager.isKillSwitchActive()).toBe(true);
  });

  // 7. Max drawdown hit → KILL MAX_DRAWDOWN
  test('max drawdown hit → KILL MAX_DRAWDOWN', () => {
    // maxDrawdownPct = 10% — trigger it by losing -199 per day over 6 days
    // so each single day stays below the -200 daily loss threshold.
    // After 6 days: balance = 10000 - 6*199 = 8806
    // drawdown = (10000 - 8806) / 10000 = 11.94% ≥ 10%
    for (let day = 0; day < 6; day++) {
      const dayTime = NEXT_DAY_TIME + day * 86_400_000;
      bus.emit('position:closed', {
        position: fixtures.openLong,
        trade: makeTrade(-199, dayTime),
      });
    }

    const signalTime = NEXT_DAY_TIME + 6 * 86_400_000 + DEFAULT_CONFIG.cooldownAfterLossMs + 1000;
    const signal = makeSignal(signalTime);
    const result = riskManager.checkEntry(signal, 50020);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rule).toBe('MAX_DRAWDOWN');
      expect(result.severity).toBe('KILL');
    }
    expect(riskManager.isKillSwitchActive()).toBe(true);
  });

  // 8. Balance tracking across multiple position:closed events
  test('balance tracks correctly across multiple position:closed events', () => {
    // Trade 1: +100, Trade 2: -50, Trade 3: +200 → net = +250 → balance = 10250
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(100, BASE_TIME + 1000),
    });
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-50, BASE_TIME + 2000),
    });
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(200, BASE_TIME + 3000),
    });

    // Signal after last trade's cooldown (last trade was +200, so no cooldown anyway)
    const signal = makeSignal(BASE_TIME + 3000);
    const result = riskManager.checkEntry(signal, 50020);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // balance = 10250 → quantity = (10250 * 0.05 * 1) / 50020
      const expected = (10250 * 0.05 * 1) / 50020;
      expect(result.quantity).toBeCloseTo(expected, 6);
    }
  });

  // 9. Daily counter resets at UTC midnight boundary
  test('daily counters reset at UTC midnight boundary', () => {
    // Use up 19 of 20 daily trades in the current day bucket
    for (let i = 0; i < 19; i++) {
      bus.emit('order:filled', {
        order: { ...fixtures.filledBuy, timestamp: BASE_TIME + i },
      });
    }

    // Emit one fill with a next-day timestamp → resets dailyTradeCount to 0, then increments to 1
    bus.emit('order:filled', {
      order: { ...fixtures.filledBuy, timestamp: NEXT_DAY_TIME },
    });

    // dailyTradeCount = 1, well below limit of 20
    const signal = makeSignal(NEXT_DAY_TIME + 1000);
    const result = riskManager.checkEntry(signal, 50020);
    expect(result.allowed).toBe(true);
  });

  // 9b. Daily PnL resets at UTC midnight boundary
  test('daily PnL resets at UTC midnight — kill switch not set from yesterday loss', () => {
    // Yesterday: lose -201 (would trigger MAX_DAILY_LOSS if checked today)
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-201, BASE_TIME),
    });

    // Next day: the daily reset happens, PnL starts from 0 again
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(0, NEXT_DAY_TIME),
    });

    // Kill switch is only set during checkEntry, not during event processing.
    // Since we never called checkEntry after the -201 loss, kill switch is NOT active.
    expect(riskManager.isKillSwitchActive()).toBe(false);

    // Now call checkEntry — daily PnL is 0 (reset happened), should not trigger MAX_DAILY_LOSS
    const signal = makeSignal(NEXT_DAY_TIME + 1000);
    const result = riskManager.checkEntry(signal, 50020);
    // daily PnL this new day is 0, which is > -200 threshold → should allow
    expect(result.allowed).toBe(true);
  });

  // 10. reset() restores initial state, kill switch cleared
  test('reset() restores initial state', () => {
    // Dirty the state — open position, fill an order, close at a big loss
    bus.emit('position:opened', { position: fixtures.openLong });
    bus.emit('order:filled', {
      order: { ...fixtures.filledBuy, timestamp: BASE_TIME },
    });
    const tradeTime = BASE_TIME + 3600000;
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-1001, tradeTime),
    });

    // Trigger kill switch via checkEntry (wait past cooldown)
    const signalBeforeReset = makeSignal(tradeTime + DEFAULT_CONFIG.cooldownAfterLossMs + 1000);
    riskManager.checkEntry(signalBeforeReset, 50020);
    expect(riskManager.isKillSwitchActive()).toBe(true);

    riskManager.reset();

    expect(riskManager.isKillSwitchActive()).toBe(false);

    // After reset: balance back to 10000, no open positions, no daily trades, no cooldown
    const result = riskManager.checkEntry(LONG_SIGNAL, 50020);
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      const expected = (10000 * 0.05 * 1) / 50020;
      expect(result.quantity).toBeCloseTo(expected, 8);
    }
  });

  // 11. dispose() — emit events after dispose → state doesn't change
  test('dispose() — events after dispose do not change state', () => {
    riskManager.dispose();

    // These should be ignored after dispose
    bus.emit('position:opened', { position: fixtures.openLong });
    bus.emit('position:opened', { position: fixtures.openLong });
    bus.emit('position:opened', { position: fixtures.openLong });

    // openPositionCount should still be 0 → MAX_CONCURRENT should NOT trigger
    const result = riskManager.checkEntry(LONG_SIGNAL, 50020);
    expect(result.allowed).toBe(true);
  });

  // Additional: openPositionCount decrements correctly on position:closed
  test('openPositionCount decrements on position:closed', () => {
    bus.emit('position:opened', { position: fixtures.openLong });
    bus.emit('position:opened', { position: fixtures.openLong });
    // 2 open positions

    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(50, BASE_TIME + 1000),
    });
    // 1 open position now

    // Should NOT trigger MAX_CONCURRENT (limit = 3, count = 1)
    const result = riskManager.checkEntry(LONG_SIGNAL, 50020);
    expect(result.allowed).toBe(true);
  });

  // Additional: isKillSwitchActive() returns false on fresh instance
  test('isKillSwitchActive() returns false on fresh instance', () => {
    expect(riskManager.isKillSwitchActive()).toBe(false);
  });

  // Additional: kill switch stays active across subsequent checkEntry calls
  test('kill switch stays active across subsequent checkEntry calls', () => {
    const tradeTime = BASE_TIME + 3600000;
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-1001, tradeTime),
    });

    // Signal after cooldown to ensure drawdown/daily-loss rule fires (not COOLDOWN)
    const signal = makeSignal(tradeTime + DEFAULT_CONFIG.cooldownAfterLossMs + 1000);

    const result1 = riskManager.checkEntry(signal, 50020);
    expect(result1.allowed).toBe(false);
    expect(riskManager.isKillSwitchActive()).toBe(true);

    // Second call — kill switch already active → returns KILL immediately
    const result2 = riskManager.checkEntry(signal, 50020);
    expect(result2.allowed).toBe(false);
    if (!result2.allowed) {
      expect(['MAX_DAILY_LOSS', 'MAX_DRAWDOWN']).toContain(result2.rule);
      expect(result2.severity).toBe('KILL');
    }
  });

  // ── additional coverage ─────────────────────────────────────────────────────

  test('MAX_POSITION_SIZE rejection when balance is zero', () => {
    // To reach the MAX_POSITION_SIZE check (step 7) without tripping MAX_DRAWDOWN
    // first (step 6), we use entryPrice=0 which makes adjustedEntry=0 and
    // quantity=Infinity (not finite). We also drain balance to 0 via a large loss
    // spread across days to confirm that zero balance produces quantity=NaN.
    // maxDailyLossPct=100 and maxDrawdownPct=100 are set to maximise headroom.
    // Because the drawdown check uses >=, a 100% drawdown still triggers it,
    // so we leave a tiny residual balance (0.01) to keep drawdown at 99.9999%.
    const permissiveConfig: RiskConfig = {
      ...DEFAULT_CONFIG,
      maxDailyLossPct: 100,
      maxDrawdownPct: 100,
    };
    const rm = new RiskManager(bus, permissiveConfig);

    // Day 1: lose most of the balance
    const day1Time = BASE_TIME + 1000;
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-9999.99, day1Time),
    });

    // balance is now 0.01, drawdown = (10000 - 0.01) / 10000 = 99.999% < 100%
    // daily PnL = -9999.99 which equals -10000 threshold → need to check:
    // threshold = -(10000 * 100 / 100) = -10000, dailyPnl = -9999.99 > -10000 → OK

    // Signal after cooldown
    const signal = makeSignal(day1Time + DEFAULT_CONFIG.cooldownAfterLossMs + 1000);
    // Use entryPrice=0 to force quantity to be non-finite (Infinity)
    const result = rm.checkEntry(signal, 0);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.rule).toBe('MAX_POSITION_SIZE');
      expect(result.severity).toBe('REJECT');
    }
  });

  describe('constructor validation', () => {
    test('constructor throws for invalid maxPositionSizePct (0)', () => {
      expect(() => {
        new RiskManager(bus, { ...DEFAULT_CONFIG, maxPositionSizePct: 0 });
      }).toThrow('maxPositionSizePct must be in (0, 100]');
    });

    test('constructor throws for invalid maxDailyLossPct (0)', () => {
      expect(() => {
        new RiskManager(bus, { ...DEFAULT_CONFIG, maxDailyLossPct: 0 });
      }).toThrow('maxDailyLossPct must be in (0, 100]');
    });

    test('constructor throws for invalid leverage (0)', () => {
      expect(() => {
        new RiskManager(bus, { ...DEFAULT_CONFIG, leverage: 0 });
      }).toThrow('leverage must be > 0');
    });
  });

  test('cooldown boundary: exactly at cooldownAfterLossMs does NOT trigger cooldown', () => {
    const lossTime = BASE_TIME;
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-50, lossTime),
    });

    // Signal arrives exactly at cooldownAfterLossMs — the check is strict <, so equality is allowed
    const signal = makeSignal(lossTime + DEFAULT_CONFIG.cooldownAfterLossMs);
    const result = riskManager.checkEntry(signal, 50020);
    // Should NOT be rejected by COOLDOWN (may still be allowed overall)
    if (!result.allowed) {
      expect(result.rule).not.toBe('COOLDOWN');
    } else {
      expect(result.allowed).toBe(true);
    }
  });

  test('expectedSlippageBps adjusts quantity calculation', () => {
    const configNoSlippage: RiskConfig = { ...DEFAULT_CONFIG };
    const configWithSlippage: RiskConfig = { ...DEFAULT_CONFIG, expectedSlippageBps: 50 }; // 50 bps = 0.5%

    const rmNoSlippage = new RiskManager(bus, configNoSlippage);
    const rmWithSlippage = new RiskManager(bus, configWithSlippage);

    const entryPrice = 50020;
    const resultNoSlippage = rmNoSlippage.checkEntry(LONG_SIGNAL, entryPrice);
    const resultWithSlippage = rmWithSlippage.checkEntry(LONG_SIGNAL, entryPrice);

    expect(resultNoSlippage.allowed).toBe(true);
    expect(resultWithSlippage.allowed).toBe(true);
    if (resultNoSlippage.allowed && resultWithSlippage.allowed) {
      // With slippage, adjusted entry is higher → quantity should be smaller
      expect(resultWithSlippage.quantity).toBeLessThan(resultNoSlippage.quantity);

      // Verify exact values:
      // noSlippage: quantity = (10000 * 0.05 * 1) / 50020
      // withSlippage: quantity = (10000 * 0.05 * 1) / (50020 * (1 + 50/10000))
      const expectedNoSlippage = (10000 * 0.05 * 1) / entryPrice;
      const expectedWithSlippage = (10000 * 0.05 * 1) / (entryPrice * (1 + 50 / 10_000));
      expect(resultNoSlippage.quantity).toBeCloseTo(expectedNoSlippage, 8);
      expect(resultWithSlippage.quantity).toBeCloseTo(expectedWithSlippage, 8);
    }
  });

  test('MAX_DAILY_LOSS kill switch clears at day boundary', () => {
    // Trigger MAX_DAILY_LOSS: lose more than 2% of 10000 = -200
    const tradeTime = BASE_TIME + 1000;
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(-201, tradeTime),
    });

    // checkEntry to activate the kill switch (after cooldown)
    const signal1 = makeSignal(tradeTime + DEFAULT_CONFIG.cooldownAfterLossMs + 1000);
    const result1 = riskManager.checkEntry(signal1, 50020);
    expect(result1.allowed).toBe(false);
    if (!result1.allowed) {
      expect(result1.rule).toBe('MAX_DAILY_LOSS');
    }
    expect(riskManager.isKillSwitchActive()).toBe(true);

    // Emit a position:closed on the next day to trigger daily reset
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(0, NEXT_DAY_TIME),
    });

    // Kill switch should have cleared because it was MAX_DAILY_LOSS
    expect(riskManager.isKillSwitchActive()).toBe(false);
  });

  test('MAX_DRAWDOWN kill switch persists across day boundaries', () => {
    // Trigger MAX_DRAWDOWN: lose > 10% of 10000 = 1000 spread across days
    // to avoid hitting MAX_DAILY_LOSS first (threshold -200 per day)
    for (let day = 0; day < 6; day++) {
      const dayTime = NEXT_DAY_TIME + day * 86_400_000;
      bus.emit('position:closed', {
        position: fixtures.openLong,
        trade: makeTrade(-199, dayTime),
      });
    }
    // balance = 10000 - 6*199 = 8806 → drawdown = 11.94% >= 10%

    // checkEntry to activate the kill switch (on the next day, after cooldown)
    const signalTime = NEXT_DAY_TIME + 6 * 86_400_000 + DEFAULT_CONFIG.cooldownAfterLossMs + 1000;
    const signal1 = makeSignal(signalTime);
    const result1 = riskManager.checkEntry(signal1, 50020);
    expect(result1.allowed).toBe(false);
    if (!result1.allowed) {
      expect(result1.rule).toBe('MAX_DRAWDOWN');
    }
    expect(riskManager.isKillSwitchActive()).toBe(true);

    // Cross another day boundary via a position:closed event
    const nextDayAfterKill = NEXT_DAY_TIME + 7 * 86_400_000;
    bus.emit('position:closed', {
      position: fixtures.openLong,
      trade: makeTrade(0, nextDayAfterKill),
    });

    // MAX_DRAWDOWN kill switch should still be active — it does NOT reset at day boundaries
    expect(riskManager.isKillSwitchActive()).toBe(true);

    // Verify checkEntry still blocks
    const signal2 = makeSignal(nextDayAfterKill + 1000);
    const result2 = riskManager.checkEntry(signal2, 50020);
    expect(result2.allowed).toBe(false);
    if (!result2.allowed) {
      expect(result2.rule).toBe('MAX_DRAWDOWN');
      expect(result2.severity).toBe('KILL');
    }
  });
});
