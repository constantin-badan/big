import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

import { BacktestSimExchange, createBacktestEngine } from '@trading-bot/backtest-engine';
import type { CandleLoader } from '@trading-bot/backtest-engine';
import { EventBus } from '@trading-bot/event-bus';
import { createEMA } from '@trading-bot/indicators';
import { BacktestExecutor } from '@trading-bot/order-executor';
import { createParityChecker } from '@trading-bot/parity-checker';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { createStorage } from '@trading-bot/storage';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import { createSweepEngine } from '@trading-bot/sweep-engine';
import type { SweepResult } from '@trading-bot/sweep-engine';
import type {
  BacktestConfig,
  BacktestResult,
  Candle,
  ExchangeConfig,
  IEventBus,
  IStrategy,
  PositionManagerConfig,
  RiskConfig,
  ScannerEvaluate,
  StrategyFactory,
  SweepParamGrid,
  Timeframe,
  TradeRecord,
  TradingEventMap,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

// ─── Shared Constants ────────────────────────────────────────────────

const BASE_TIME = 1_700_000_000_000;
const BTCUSDT = toSymbol('BTCUSDT');
const CANDLE_MS = 60_000;
const TF_1M: Timeframe = '1m';

// ─── Deterministic Candle Generator ──────────────────────────────────

/**
 * Builds 50 candles with a predictable price pattern:
 *   0-19 : UP    from 100 to 195  (close = 100 + i * 5)
 *   20-34: DOWN  from 200 to 130  (close = 200 - (i-20) * 5)
 *   35-49: UP    from 130 to 200  (close = 130 + (i-35) * 5)
 */
function makeGoldenCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    let close: number;
    if (i <= 19) {
      close = 100 + i * 5;
    } else if (i <= 34) {
      close = 200 - (i - 20) * 5;
    } else {
      close = 130 + (i - 35) * 5;
    }
    const open = close - 1;
    const high = close + 2;
    const low = close - 2;
    candles.push({
      symbol: BTCUSDT,
      openTime: BASE_TIME + i * CANDLE_MS,
      closeTime: BASE_TIME + (i + 1) * CANDLE_MS - 1,
      open,
      high,
      low,
      close,
      volume: 1000,
      quoteVolume: 1000 * close,
      trades: 100,
      isClosed: true,
    });
  }
  return candles;
}

// ─── EMA Crossover Strategy Factory (parameterized) ─────────────────

function makeEmaCrossoverFactory(
  riskCfg: RiskConfig,
  pmCfg: PositionManagerConfig,
): StrategyFactory {
  return (params, deps) => {
    const fastPeriod = params.fastPeriod ?? 5;
    const slowPeriod = params.slowPeriod ?? 10;

    const prevFastMap = new Map<string, number>();
    const prevSlowMap = new Map<string, number>();

    const evaluate: ScannerEvaluate = (indicators, candle, symbol) => {
      const fast = indicators.fast;
      const slow = indicators.slow;
      if (fast === undefined || slow === undefined) return null;

      const prevFast = prevFastMap.get(symbol) ?? null;
      const prevSlow = prevSlowMap.get(symbol) ?? null;

      prevFastMap.set(symbol, fast);
      prevSlowMap.set(symbol, slow);

      if (prevFast === null || prevSlow === null) return null;

      if (prevFast <= prevSlow && fast > slow) {
        return {
          action: 'ENTER_LONG',
          confidence: 0.9,
          price: candle.close,
          metadata: { fast, slow, crossover: 'bullish' },
        };
      }

      if (prevFast >= prevSlow && fast < slow) {
        return {
          action: 'ENTER_SHORT',
          confidence: 0.9,
          price: candle.close,
          metadata: { fast, slow, crossover: 'bearish' },
        };
      }

      return null;
    };

    const scannerFactory = createScannerFactory('ema-cross', evaluate);
    const scanner = scannerFactory(deps.bus, {
      symbols: [BTCUSDT],
      timeframe: '1m',
      indicators: {
        fast: () => createEMA({ period: fastPeriod }),
        slow: () => createEMA({ period: slowPeriod }),
      },
    });

    const riskManager = new RiskManager(deps.bus, riskCfg);
    const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, pmCfg);

    return new Strategy(
      {
        name: 'ema-crossover',
        symbols: [BTCUSDT],
        scanners: [scanner],
        signalMerge: passthroughMerge,
        signalBufferWindowMs: 60_000,
        positionManager,
        riskManager,
      },
      deps,
    );
  };
}

// ─── Configs ─────────────────────────────────────────────────────────

const exchangeConfig: ExchangeConfig = {
  type: 'backtest-sim',
  feeStructure: { maker: 0.0002, taker: 0.0004 },
  slippageModel: { type: 'fixed', fixedBps: 0 },
  initialBalance: 10_000,
};

const riskConfig: RiskConfig = {
  maxPositionSizePct: 10,
  maxConcurrentPositions: 1,
  maxDailyLossPct: 50,
  maxDrawdownPct: 50,
  maxDailyTrades: 100,
  cooldownAfterLossMs: 0,
  leverage: 1,
  initialBalance: 10_000,
};

const pmConfig: PositionManagerConfig = {
  defaultStopLossPct: 5,
  defaultTakeProfitPct: 10,
  trailingStopEnabled: false,
  trailingStopActivationPct: 0,
  trailingStopDistancePct: 0,
  maxHoldTimeMs: 999_999_999,
};

// ─── Arena Instance Helper ──────────────────────────────────────────

interface ArenaInstance {
  bus: IEventBus;
  strategy: IStrategy;
  trades: TradeRecord[];
  sim: BacktestSimExchange;
  detachFromSource: () => void;
}

function createArenaInstance(
  sourceBus: IEventBus,
  factory: StrategyFactory,
  params: Record<string, number>,
): ArenaInstance {
  const bus = new EventBus();
  const sim = new BacktestSimExchange(bus, {
    feeStructure: { maker: 0.0002, taker: 0.0004 },
    slippageModel: { type: 'fixed', fixedBps: 0 },
    initialBalance: 10_000,
    leverage: 1,
  });
  const executor = new BacktestExecutor(bus, sim);

  const trades: TradeRecord[] = [];
  bus.on('position:closed', (data: TradingEventMap['position:closed']) => {
    trades.push(data.trade);
  });

  const fwdCandle = (data: TradingEventMap['candle:close']): void => { bus.emit('candle:close', data); };
  const fwdUpdate = (data: TradingEventMap['candle:update']): void => { bus.emit('candle:update', data); };
  const fwdTick = (data: TradingEventMap['tick']): void => { bus.emit('tick', data); };
  sourceBus.on('candle:close', fwdCandle);
  sourceBus.on('candle:update', fwdUpdate);
  sourceBus.on('tick', fwdTick);

  const detachFromSource = (): void => {
    sourceBus.off('candle:close', fwdCandle);
    sourceBus.off('candle:update', fwdUpdate);
    sourceBus.off('tick', fwdTick);
  };

  const strategy = factory(params, { bus, exchange: sim, executor });
  return { bus, strategy, trades, sim, detachFromSource };
}

function pumpCandles(bus: IEventBus, candles: Candle[]): void {
  for (const candle of candles) {
    bus.emit('candle:close', { symbol: BTCUSDT, timeframe: TF_1M, candle });
  }
}

async function cleanupInstances(instances: ArenaInstance[]): Promise<void> {
  for (const inst of instances) {
    await inst.strategy.stop();
    inst.detachFromSource();
    inst.sim.dispose();
  }
}

// =====================================================================
// Describe Block 1: Sweep -> Arena Reproducibility
// =====================================================================

describe('Sweep -> Arena reproducibility', () => {
  const goldenCandles = makeGoldenCandles();

  const btConfig: BacktestConfig = {
    startTime: goldenCandles[0]!.openTime,
    endTime: goldenCandles[goldenCandles.length - 1]!.closeTime + 1,
    symbols: [BTCUSDT],
    timeframes: ['1m'],
  };

  const grid: SweepParamGrid = {
    fastPeriod: [3, 5],
    slowPeriod: [8, 10],
  };

  const loader: CandleLoader = async () => goldenCandles;
  const factory = makeEmaCrossoverFactory(riskConfig, pmConfig);

  let sweepResults: SweepResult[];
  let top3: SweepResult[];

  beforeAll(async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    const sweep = createSweepEngine(engine);
    sweepResults = await sweep.run(factory, grid, btConfig);
    // Top 3 by profit factor (results are already sorted descending by profitFactor)
    top3 = sweepResults.slice(0, 3);
  });

  test('sweep produces exactly 4 results', () => {
    expect(sweepResults.length).toBe(4);
  });

  test.each([0, 1, 2])('top3[%i]: arena trades exactly match sweep trades', async (idx) => {
    const sweepEntry = top3[idx]!;
    const sweepTrades = sweepEntry.result.trades;

    // Create an arena instance with the same params and pump golden candles
    const sourceBus = new EventBus();
    const instance = createArenaInstance(sourceBus, factory, sweepEntry.params);
    await instance.strategy.start();
    pumpCandles(sourceBus, goldenCandles);
    await cleanupInstances([instance]);

    const arenaTrades = instance.trades;

    // Same trade count
    expect(arenaTrades.length).toBe(sweepTrades.length);

    // Per-trade exact match
    for (let t = 0; t < sweepTrades.length; t++) {
      const sweep = sweepTrades[t]!;
      const arena = arenaTrades[t]!;

      expect(arena.entryPrice).toBe(sweep.entryPrice);
      expect(arena.exitPrice).toBe(sweep.exitPrice);
      expect(arena.exitReason).toBe(sweep.exitReason);
      expect(arena.pnl).toBe(sweep.pnl);
    }
  });
});

// =====================================================================
// Describe Block 2: Parity Checker Integration
// =====================================================================

describe('Parity checker integration', () => {
  const goldenCandles = makeGoldenCandles();

  const btConfig: BacktestConfig = {
    startTime: goldenCandles[0]!.openTime,
    endTime: goldenCandles[goldenCandles.length - 1]!.closeTime + 1,
    symbols: [BTCUSDT],
    timeframes: ['1m'],
  };

  const factory = makeEmaCrossoverFactory(riskConfig, pmConfig);
  const strategyName = 'ema-crossover-parity';

  let dbPath: string;
  let closeDb: () => void;

  beforeAll(() => {
    dbPath = join(tmpdir(), `parity-test-${Date.now()}.db`);
  });

  afterAll(() => {
    try { closeDb?.(); } catch { /* ignore */ }
    try { unlinkSync(dbPath); } catch { /* ignore */ }
  });

  test('zero-drift baseline — backtest trades inserted unmodified produce perfect parity', async () => {
    // 1. Run a backtest
    const loader: CandleLoader = async () => goldenCandles;
    const engine = createBacktestEngine(loader, exchangeConfig);
    const backtestResult: BacktestResult = await engine.run(
      factory,
      { fastPeriod: 5, slowPeriod: 10 },
      btConfig,
    );

    expect(backtestResult.trades.length).toBeGreaterThan(0);

    // 2. Create storage and insert trades + candles
    const storage = createStorage(dbPath);
    closeDb = storage.close;

    for (const trade of backtestResult.trades) {
      storage.trades.insertTrade(strategyName, trade);
    }
    storage.candles.insertCandles(BTCUSDT, '1m', goldenCandles);

    // 3. Create a CandleLoader that reads from the candle store
    const storeLoader: CandleLoader = async (symbol, timeframe, startTime, endTime) => {
      return storage.candles.getCandles(symbol, timeframe, startTime, endTime);
    };

    // 4. Create parity checker with a backtest engine backed by the store loader
    const parityEngine = createBacktestEngine(storeLoader, exchangeConfig);
    const checker = createParityChecker(parityEngine, storage.trades, ['1m']);

    // 5. Run parity check
    // exitTime in trade records uses Date.now() (wall-clock) from BacktestSimExchange,
    // so we need endTime large enough to include those timestamps. Use a wide window
    // that covers both simulation-time entries and wall-clock exits.
    const parityPeriod = { startTime: btConfig.startTime, endTime: Date.now() + 60_000 };
    const parityResult = await checker.compare(
      strategyName,
      factory,
      { fastPeriod: 5, slowPeriod: 10 },
      parityPeriod,
    );

    // 6. Assert perfect parity
    expect(parityResult.summary.matchRate).toBe(1.0);
    expect(parityResult.liveOnly.length).toBe(0);
    expect(parityResult.backtestOnly.length).toBe(0);
    expect(parityResult.summary.meanEntryDeviationBps).toBe(0);
    expect(parityResult.summary.meanPnlDeviation).toBe(0);
  });

  test('known-drift — +2bps entry offset detected correctly', async () => {
    // Use a fresh DB for this test to avoid interference
    const driftDbPath = join(tmpdir(), `parity-drift-${Date.now()}.db`);
    const driftStorage = createStorage(driftDbPath);
    const driftStrategyName = 'ema-crossover-drift';

    try {
      // 1. Run a backtest
      const loader: CandleLoader = async () => goldenCandles;
      const engine = createBacktestEngine(loader, exchangeConfig);
      const backtestResult: BacktestResult = await engine.run(
        factory,
        { fastPeriod: 5, slowPeriod: 10 },
        btConfig,
      );

      expect(backtestResult.trades.length).toBeGreaterThan(0);

      // 2. Modify trades: shift entryPrice by +2bps, exitPrice by -1bps, recalculate PnL
      const modifiedTrades: TradeRecord[] = backtestResult.trades.map((trade, i) => {
        const newEntryPrice = trade.entryPrice * 1.0002;
        const newExitPrice = trade.exitPrice * 0.9999;
        const direction = trade.side === 'LONG' ? 1 : -1;
        const newPnl = (newExitPrice - newEntryPrice) * direction * trade.quantity - trade.fees;

        return {
          ...trade,
          id: `drift-${i}-${trade.id}`,
          entryPrice: newEntryPrice,
          exitPrice: newExitPrice,
          pnl: newPnl,
        };
      });

      // 3. Insert modified trades and candles into storage
      for (const trade of modifiedTrades) {
        driftStorage.trades.insertTrade(driftStrategyName, trade);
      }
      driftStorage.candles.insertCandles(BTCUSDT, '1m', goldenCandles);

      // 4. Create parity checker
      const storeLoader: CandleLoader = async (symbol, timeframe, startTime, endTime) => {
        return driftStorage.candles.getCandles(symbol, timeframe, startTime, endTime);
      };
      const parityEngine = createBacktestEngine(storeLoader, exchangeConfig);
      const checker = createParityChecker(parityEngine, driftStorage.trades, ['1m']);

      // 5. Run parity check (wide endTime for same Date.now() reason as zero-drift test)
      const parityPeriod = { startTime: btConfig.startTime, endTime: Date.now() + 60_000 };
      const parityResult = await checker.compare(
        driftStrategyName,
        factory,
        { fastPeriod: 5, slowPeriod: 10 },
        parityPeriod,
      );

      // 6. Assert drift detection
      // All trades should match (same count, same timestamps, same sides)
      expect(parityResult.matched.length).toBeGreaterThan(0);
      expect(parityResult.liveOnly.length).toBe(0);
      expect(parityResult.backtestOnly.length).toBe(0);

      // meanEntryDeviationBps should be close to 2 (live entry is +2bps above backtest)
      // bpsDiff = ((live - backtest) / backtest) * 10_000
      // live = backtest * 1.0002, so bpsDiff = 0.0002 * 10000 = 2
      expect(parityResult.summary.meanEntryDeviationBps).toBeCloseTo(2, 1);

      // Live PnL is worse because entries are higher and exits are lower.
      // meanPnlDeviation = mean(live.pnl - backtest.pnl) — should be negative.
      // backtestOverestimatesPnl = meanPnlDeviation < 0 — should be true.
      expect(parityResult.summary.backtestOverestimatesPnl).toBe(true);
    } finally {
      driftStorage.close();
      try { unlinkSync(driftDbPath); } catch { /* ignore */ }
    }
  });
});
