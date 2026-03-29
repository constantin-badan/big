import { describe, test, expect } from 'bun:test';

import type { IBacktestEngine } from '@trading-bot/backtest-engine';
import type { ITradeStore } from '@trading-bot/storage';
import type { IStrategy } from '@trading-bot/types';
import type { BacktestResult, PerformanceMetrics, TradeRecord } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { createParityChecker } from '../parity-checker';

const BASE_TIME = 1700000000000;

const ZERO_METRICS: PerformanceMetrics = {
  totalTrades: 0,
  winRate: 0,
  profitFactor: 0,
  sharpeRatio: 0,
  maxDrawdown: 0,
  maxDrawdownDuration: 0,
  avgWin: 0,
  avgLoss: 0,
  expectancy: 0,
  avgHoldTime: 0,
  totalFees: 0,
  totalSlippage: 0,
};

function makeTrade(id: string, overrides?: Partial<TradeRecord>): TradeRecord {
  return {
    id,
    symbol: toSymbol('BTCUSDT'),
    side: 'LONG',
    entryPrice: 50000,
    exitPrice: 50500,
    quantity: 0.1,
    entryTime: BASE_TIME,
    exitTime: BASE_TIME + 3600_000,
    pnl: 50,
    fees: 2,
    slippage: 0.5,
    holdTimeMs: 3600_000,
    exitReason: 'TAKE_PROFIT',
    metadata: {},
    ...overrides,
  };
}

function mockTradeStore(trades: TradeRecord[]): ITradeStore {
  return { insertTrade: () => {}, getTrades: () => trades };
}

function mockEngine(trades: TradeRecord[]): IBacktestEngine {
  const result: BacktestResult = {
    trades,
    startTime: BASE_TIME,
    endTime: BASE_TIME + 86400_000,
    initialBalance: 10000,
    finalBalance: 10050,
    metrics: { ...ZERO_METRICS, totalTrades: trades.length },
  };
  return { run: async () => result };
}

function stubFactory(): IStrategy {
  return {
    name: 'test',
    start: async () => {},
    stop: async () => {},
    getStats: () => ZERO_METRICS,
  };
}

const PERIOD = { startTime: BASE_TIME, endTime: BASE_TIME + 86400_000 };

describe('parity-checker', () => {
  test('matches identical trades', async () => {
    const trade = makeTrade('t1');
    const checker = createParityChecker(mockEngine([trade]), mockTradeStore([trade]), ['1m']);

    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(1);
    expect(result.liveOnly).toHaveLength(0);
    expect(result.backtestOnly).toHaveLength(0);
    expect(result.matched[0]!.entryPriceDiffBps).toBe(0);
    expect(result.matched[0]!.pnlDiff).toBe(0);
    expect(result.matched[0]!.exitReasonMatch).toBe(true);
    expect(result.summary.matchRate).toBe(1);
  });

  test('detects entry price divergence in bps', async () => {
    const liveTrade = makeTrade('t1', { entryPrice: 50010 });
    const btTrade = makeTrade('bt1', { entryPrice: 50000 });

    const checker = createParityChecker(mockEngine([btTrade]), mockTradeStore([liveTrade]), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.entryPriceDiffBps).toBeCloseTo(2, 1);
  });

  test('detects backtest overestimating PnL', async () => {
    const liveTrade = makeTrade('t1', { pnl: 40 });
    const btTrade = makeTrade('bt1', { pnl: 50 });

    const checker = createParityChecker(mockEngine([btTrade]), mockTradeStore([liveTrade]), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.summary.backtestOverestimatesPnl).toBe(true);
    expect(result.summary.meanPnlDeviation).toBe(-10);
  });

  test('handles live-only trades', async () => {
    const checker = createParityChecker(mockEngine([]), mockTradeStore([makeTrade('t1')]), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(0);
    expect(result.liveOnly).toHaveLength(1);
    expect(result.backtestOnly).toHaveLength(0);
  });

  test('handles backtest-only trades', async () => {
    const checker = createParityChecker(mockEngine([makeTrade('bt1')]), mockTradeStore([]), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(0);
    expect(result.liveOnly).toHaveLength(0);
    expect(result.backtestOnly).toHaveLength(1);
  });

  test('fuzzy matches within tolerance window', async () => {
    const liveTrade = makeTrade('t1', { entryTime: BASE_TIME + 30_000 });
    const btTrade = makeTrade('bt1', { entryTime: BASE_TIME });

    const checker = createParityChecker(mockEngine([btTrade]), mockTradeStore([liveTrade]), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(1);
  });

  test('does not match trades outside tolerance window', async () => {
    const liveTrade = makeTrade('t1', { entryTime: BASE_TIME + 120_000 });
    const btTrade = makeTrade('bt1', { entryTime: BASE_TIME });

    const checker = createParityChecker(mockEngine([btTrade]), mockTradeStore([liveTrade]), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(0);
    expect(result.liveOnly).toHaveLength(1);
    expect(result.backtestOnly).toHaveLength(1);
  });

  test('does not match different symbols', async () => {
    const liveTrade = makeTrade('t1', { symbol: toSymbol('BTCUSDT') });
    const btTrade = makeTrade('bt1', { symbol: toSymbol('ETHUSDT') });

    const checker = createParityChecker(mockEngine([btTrade]), mockTradeStore([liveTrade]), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(0);
  });

  test('empty trades returns clean result', async () => {
    const checker = createParityChecker(mockEngine([]), mockTradeStore([]), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(0);
    expect(result.summary.matchRate).toBe(0);
    expect(result.summary.backtestOverestimatesPnl).toBe(false);
  });

  test('uses finest timeframe for tolerance', async () => {
    // 4h tolerance = 14_400_000ms — should match trades 2 hours apart
    const liveTrade = makeTrade('t1', { entryTime: BASE_TIME + 7_200_000 });
    const btTrade = makeTrade('bt1', { entryTime: BASE_TIME });

    const checker4h = createParityChecker(mockEngine([btTrade]), mockTradeStore([liveTrade]), [
      '4h',
    ]);
    const result4h = await checker4h.compare('test', stubFactory, {}, PERIOD);
    expect(result4h.matched).toHaveLength(1);

    // 1m tolerance = 60_000ms — should NOT match
    const checker1m = createParityChecker(mockEngine([btTrade]), mockTradeStore([liveTrade]), [
      '1m',
    ]);
    const result1m = await checker1m.compare('test', stubFactory, {}, PERIOD);
    expect(result1m.matched).toHaveLength(0);
  });

  test('pearson correlation of identical arrays is 1.0', async () => {
    // Create 5 matched trade pairs with identical PnL values.
    // pearsonCorrelation is exercised through pnlCorrelation in the summary.
    const liveTrades = Array.from({ length: 5 }, (_, i) =>
      makeTrade(`live-${i}`, {
        entryTime: BASE_TIME + i * 60_000,
        pnl: 10 + i * 5,
      }),
    );
    const btTrades = Array.from({ length: 5 }, (_, i) =>
      makeTrade(`bt-${i}`, {
        entryTime: BASE_TIME + i * 60_000,
        pnl: 10 + i * 5,
      }),
    );

    const checker = createParityChecker(mockEngine(btTrades), mockTradeStore(liveTrades), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(5);
    expect(result.summary.pnlCorrelation).toBeCloseTo(1.0, 10);
  });

  test('pearson correlation of perfectly inverse arrays is -1.0', async () => {
    // Create 5 matched trade pairs where live PnL and backtest PnL are perfectly inversely correlated.
    const pnlValues = [10, 20, 30, 40, 50];
    const liveTrades = pnlValues.map((pnl, i) =>
      makeTrade(`live-${i}`, {
        entryTime: BASE_TIME + i * 60_000,
        pnl,
      }),
    );
    // Inverse: when live goes up, backtest goes down by the same amount
    const inversePnlValues = [50, 40, 30, 20, 10];
    const btTrades = inversePnlValues.map((pnl, i) =>
      makeTrade(`bt-${i}`, {
        entryTime: BASE_TIME + i * 60_000,
        pnl,
      }),
    );

    const checker = createParityChecker(mockEngine(btTrades), mockTradeStore(liveTrades), ['1m']);
    const result = await checker.compare('test', stubFactory, {}, PERIOD);

    expect(result.matched).toHaveLength(5);
    expect(result.summary.pnlCorrelation).toBeCloseTo(-1.0, 10);
  });
});
