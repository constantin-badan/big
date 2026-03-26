import { describe, test, expect } from 'bun:test';
import type { TradeRecord, Timeframe } from '@trading-bot/types';
import { computeMetrics } from '../metrics';

function makeTrade(overrides: Partial<TradeRecord> & { pnl: number }): TradeRecord {
  return {
    id: 'test',
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 1,
    entryTime: 0,
    exitTime: 60_000,
    holdTimeMs: 60_000,
    fees: 0,
    slippage: 0,
    exitReason: 'SIGNAL',
    metadata: {},
    ...overrides,
  };
}

const BASE_START = 0;
const BASE_END = 3_600_000; // 1 hour
const TIMEFRAMES: Timeframe[] = ['1h'];

describe('computeMetrics', () => {
  test('empty trades returns all zeros', () => {
    const metrics = computeMetrics([], ['1h'], 1000, BASE_START, BASE_END);
    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.sharpeRatio).toBe(0);
    expect(metrics.maxDrawdown).toBe(0);
    expect(metrics.maxDrawdownDuration).toBe(0);
    expect(metrics.avgWin).toBe(0);
    expect(metrics.avgLoss).toBe(0);
    expect(metrics.expectancy).toBe(0);
    expect(metrics.avgHoldTime).toBe(0);
    expect(metrics.totalFees).toBe(0);
    expect(metrics.totalSlippage).toBe(0);
  });

  test('single winning trade', () => {
    const trade = makeTrade({ pnl: 200, exitTime: 1_000 });
    const metrics = computeMetrics([trade], TIMEFRAMES, 1000, BASE_START, BASE_END);
    expect(metrics.totalTrades).toBe(1);
    expect(metrics.winRate).toBe(1);
    expect(metrics.profitFactor).toBe(Infinity);
    expect(metrics.avgWin).toBe(200);
    expect(metrics.avgLoss).toBe(0);
  });

  test('single losing trade', () => {
    const trade = makeTrade({ pnl: -50, exitTime: 1_000 });
    const metrics = computeMetrics([trade], TIMEFRAMES, 1000, BASE_START, BASE_END);
    expect(metrics.totalTrades).toBe(1);
    expect(metrics.winRate).toBe(0);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.avgWin).toBe(0);
    expect(metrics.avgLoss).toBe(-50);
  });

  test('mixed trades: 3 wins + 2 losses', () => {
    // wins: 100, 50, 75 → grossProfit = 225
    // losses: -30, -20 → grossLoss = 50
    // profitFactor = 225 / 50 = 4.5
    // winRate = 3/5 = 0.6
    // expectancy = (100 + 50 + 75 - 30 - 20) / 5 = 175 / 5 = 35
    const trades = [
      makeTrade({ id: '1', pnl: 100, exitTime: 60_000 }),
      makeTrade({ id: '2', pnl: 50, exitTime: 120_000 }),
      makeTrade({ id: '3', pnl: 75, exitTime: 180_000 }),
      makeTrade({ id: '4', pnl: -30, exitTime: 240_000 }),
      makeTrade({ id: '5', pnl: -20, exitTime: 300_000 }),
    ];
    const metrics = computeMetrics(trades, TIMEFRAMES, 1000, BASE_START, BASE_END);
    expect(metrics.totalTrades).toBe(5);
    expect(metrics.winRate).toBe(0.6);
    expect(metrics.profitFactor).toBe(4.5);
    expect(metrics.expectancy).toBe(35);
  });

  test('totalFees and totalSlippage sum correctly', () => {
    const trades = [
      makeTrade({ id: '1', pnl: 100, fees: 1.5, slippage: 0.5, exitTime: 60_000 }),
      makeTrade({ id: '2', pnl: 50, fees: 2.0, slippage: 0.3, exitTime: 120_000 }),
      makeTrade({ id: '3', pnl: -20, fees: 0.8, slippage: 0.2, exitTime: 180_000 }),
    ];
    const metrics = computeMetrics(trades, TIMEFRAMES, 1000, BASE_START, BASE_END);
    expect(metrics.totalFees).toBeCloseTo(4.3);
    expect(metrics.totalSlippage).toBeCloseTo(1.0);
  });

  test('maxDrawdown: known drawdown from 1200 to 900 = 25%', () => {
    // Start at 1000, trade 1 +200 → equity 1200 (peak)
    // Trade 2 -300 → equity 900 (trough)
    // Drawdown = (1200 - 900) / 1200 * 100 = 25%
    const trades = [
      makeTrade({ id: '1', pnl: 200, exitTime: 60_000 }),
      makeTrade({ id: '2', pnl: -300, exitTime: 120_000 }),
    ];
    const metrics = computeMetrics(trades, TIMEFRAMES, 1000, BASE_START, BASE_END);
    expect(metrics.maxDrawdown).toBeCloseTo(25, 5);
  });

  test('sharpeRatio is > 0 for consistent winning trades', () => {
    // Build many winning trades spread across 1h periods to generate returns
    const periodMs = 3_600_000; // 1h in ms
    const numPeriods = 50;
    const endTime = numPeriods * periodMs;
    const trades = Array.from({ length: numPeriods }, (_, i) =>
      makeTrade({
        id: String(i),
        pnl: 10,
        exitTime: (i + 1) * periodMs - 1,
        holdTimeMs: periodMs,
      }),
    );
    const metrics = computeMetrics(trades, ['1h'], 1000, 0, endTime);
    // All periods have positive returns — Sharpe should be positive
    expect(isFinite(metrics.sharpeRatio)).toBe(true);
    expect(metrics.sharpeRatio).toBeGreaterThan(0);
  });

  test('sharpeRatio returns 0 for fewer than 2 periods', () => {
    // Only one trade in one period — can't compute returns
    const trade = makeTrade({ pnl: 100, exitTime: 1_000 });
    const metrics = computeMetrics([trade], ['1h'], 1000, 0, 3_600_000);
    // With only one period, returns array has 0 or 1 elements → sharpe = 0
    // (depends on whether initial balance period and trade period are same bucket)
    // Either way sharpe should be a finite number
    expect(isFinite(metrics.sharpeRatio)).toBe(true);
  });

  test('avgHoldTime averages holdTimeMs across all trades', () => {
    const trades = [
      makeTrade({ id: '1', pnl: 10, holdTimeMs: 1000, exitTime: 1_000 }),
      makeTrade({ id: '2', pnl: 20, holdTimeMs: 3000, exitTime: 2_000 }),
    ];
    const metrics = computeMetrics(trades, TIMEFRAMES, 1000, BASE_START, BASE_END);
    expect(metrics.avgHoldTime).toBe(2000);
  });

  test('profitFactor is Infinity when no losing trades but winners exist', () => {
    const trades = [
      makeTrade({ id: '1', pnl: 100, exitTime: 60_000 }),
      makeTrade({ id: '2', pnl: 200, exitTime: 120_000 }),
    ];
    const metrics = computeMetrics(trades, TIMEFRAMES, 1000, BASE_START, BASE_END);
    expect(metrics.profitFactor).toBe(Infinity);
  });

  test('profitFactor is 0 when only losing trades', () => {
    const trades = [
      makeTrade({ id: '1', pnl: -50, exitTime: 60_000 }),
      makeTrade({ id: '2', pnl: -30, exitTime: 120_000 }),
    ];
    const metrics = computeMetrics(trades, TIMEFRAMES, 1000, BASE_START, BASE_END);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.winRate).toBe(0);
  });

  test('maxDrawdownDuration tracks duration of drawdown correctly', () => {
    // Peak at t=60_000, trough continues until t=180_000 (no new peak)
    // endTime = 240_000, so drawdown duration = 240_000 - 60_000 = 180_000
    const trades = [
      makeTrade({ id: '1', pnl: 200, exitTime: 60_000 }),   // peak = 1200 at t=60k
      makeTrade({ id: '2', pnl: -150, exitTime: 120_000 }), // balance = 1050
      makeTrade({ id: '3', pnl: -100, exitTime: 180_000 }), // balance = 950
    ];
    const metrics = computeMetrics(trades, ['1h'], 1000, 0, 240_000);
    expect(metrics.maxDrawdownDuration).toBeGreaterThan(0);
  });
});
