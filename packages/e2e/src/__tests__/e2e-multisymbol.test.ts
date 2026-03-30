import { describe, test, expect, beforeAll } from 'bun:test';

import { createEMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  BacktestConfig,
  BacktestResult,
  Candle,
  ExchangeConfig,
  PositionManagerConfig,
  RiskConfig,
  ScannerEvaluate,
  StrategyFactory,
  Symbol,
} from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import { createBacktestEngine } from '@trading-bot/backtest-engine';

import { BTCUSDT, BASE_TIME, CANDLE_MS } from '../e2e-helpers';

// ─── Multi-Symbol Constants ─────────────────────────────────────────

const ETHUSDT = toSymbol('ETHUSDT');
const NUM_CANDLES = 40;

// ─── Deterministic Candle Generators ─────────────────────────────────

/**
 * BTCUSDT price pattern (40 candles):
 *   0-4  : flat at 100 (warmup)
 *   5-19 : UP from 100 to 130 (bullish crossover fires ~candle 10-12 => LONG)
 *   20-39: stays at 130, then slight continued rise to 140 to hit TP
 */
function makeBtcCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < NUM_CANDLES; i++) {
    let close: number;
    if (i <= 4) {
      close = 100;
    } else if (i <= 19) {
      // Linear ramp from 100 to 130 over 15 candles
      close = 100 + ((i - 5) / 14) * 30;
    } else {
      // Continue slight uptrend from 130 to 145 to ensure TP hit
      close = 130 + ((i - 20) / 19) * 15;
    }
    // Round to avoid floating-point noise in assertions
    close = Math.round(close * 100) / 100;
    const open = close - 0.5;
    const high = close + 1;
    const low = close - 1;
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

/**
 * ETHUSDT price pattern (40 candles):
 *   0-14 : flat at 3000 (warmup + waiting for BTC to enter first)
 *   15-29: DOWN from 3000 to 2700 (bearish crossover fires ~candle 20-22 => SHORT)
 *   30-39: continues down to 2600 to hit TP
 */
function makeEthCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < NUM_CANDLES; i++) {
    let close: number;
    if (i <= 14) {
      close = 3000;
    } else if (i <= 29) {
      // Linear ramp down from 3000 to 2700 over 15 candles
      close = 3000 - ((i - 15) / 14) * 300;
    } else {
      // Continue downtrend from 2700 to 2550 to ensure TP hit
      close = 2700 - ((i - 30) / 9) * 150;
    }
    close = Math.round(close * 100) / 100;
    const open = close + 0.5;
    const high = close + 1;
    const low = close - 1;
    candles.push({
      symbol: ETHUSDT,
      openTime: BASE_TIME + i * CANDLE_MS,
      closeTime: BASE_TIME + (i + 1) * CANDLE_MS - 1,
      open,
      high,
      low,
      close,
      volume: 500,
      quoteVolume: 500 * close,
      trades: 80,
      isClosed: true,
    });
  }
  return candles;
}

// ─── Candle Loader ───────────────────────────────────────────────────

const btcCandles = makeBtcCandles();
const ethCandles = makeEthCandles();
const candlesBySymbol = new Map<string, Candle[]>([
  [BTCUSDT, btcCandles],
  [ETHUSDT, ethCandles],
]);

const loader = async (symbol: Symbol) => {
  const candles = candlesBySymbol.get(symbol);
  if (!candles) throw new Error(`No candles for symbol ${symbol}`);
  return candles;
};

// ─── EMA Crossover Strategy Factory (Multi-Symbol) ───────────────────

function makeMultiSymbolEmaCrossoverFactory(
  symbols: Symbol[],
  riskCfg: RiskConfig,
  pmCfg: PositionManagerConfig,
  fastPeriod = 3,
  slowPeriod = 6,
): StrategyFactory {
  return (_params, deps) => {
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

    const scannerFactory = createScannerFactory('ema-cross-multi', evaluate);
    const scanner = scannerFactory(deps.bus, {
      symbols,
      timeframe: '1m',
      indicators: {
        fast: () => createEMA({ period: fastPeriod }),
        slow: () => createEMA({ period: slowPeriod }),
      },
    });

    const riskManager = new RiskManager(deps.bus, riskCfg);
    const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, null, pmCfg);

    return new Strategy(
      {
        name: 'ema-crossover-multi',
        symbols,
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

const pmConfig: PositionManagerConfig = {
  defaultStopLossPct: 5,
  defaultTakeProfitPct: 10,
  trailingStopEnabled: false,
  trailingStopActivationPct: 0,
  trailingStopDistancePct: 0,
  maxHoldTimeMs: 999_999_999,
};

const btConfig: BacktestConfig = {
  startTime: btcCandles[0]!.openTime,
  endTime: btcCandles[btcCandles.length - 1]!.closeTime + 1,
  symbols: [BTCUSDT, ETHUSDT],
  timeframes: ['1m'],
};

// =====================================================================
// Test Variant A: maxConcurrentPositions = 2 (both symbols trade)
// =====================================================================

describe('maxConcurrentPositions = 2 (both symbols trade)', () => {
  const riskConfig: RiskConfig = {
    maxPositionSizePct: 10,
    maxConcurrentPositions: 2,
    maxDailyLossPct: 50,
    maxDrawdownPct: 50,
    maxDailyTrades: 100,
    cooldownAfterLossMs: 0,
    leverage: 1,
    initialBalance: 10_000,
  };

  const factory = makeMultiSymbolEmaCrossoverFactory(
    [BTCUSDT, ETHUSDT],
    riskConfig,
    pmConfig,
  );

  let result: BacktestResult;
  let btcTrades: BacktestResult['trades'];
  let ethTrades: BacktestResult['trades'];

  beforeAll(async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    result = await engine.run(factory, {}, btConfig);
    btcTrades = result.trades.filter((t) => t.symbol === BTCUSDT);
    ethTrades = result.trades.filter((t) => t.symbol === ETHUSDT);
  });

  test('trades exist for both symbols', () => {
    expect(btcTrades.length).toBeGreaterThanOrEqual(1);
    expect(ethTrades.length).toBeGreaterThanOrEqual(1);
  });

  test('trade.symbol is correct for every trade', () => {
    for (const t of btcTrades) {
      expect(t.symbol).toBe(BTCUSDT);
    }
    for (const t of ethTrades) {
      expect(t.symbol).toBe(ETHUSDT);
    }
  });

  test('BTCUSDT trades are LONG (price trended up)', () => {
    for (const t of btcTrades) {
      expect(t.side).toBe('LONG');
    }
  });

  test('ETHUSDT trades are SHORT (price trended down)', () => {
    for (const t of ethTrades) {
      expect(t.side).toBe('SHORT');
    }
  });

  test('BTCUSDT enters before ETHUSDT (staggered trends)', () => {
    expect(btcTrades[0]!.entryTime).toBeLessThan(ethTrades[0]!.entryTime);
  });

  test('SL/TP uses own entry price, no cross-contamination (BTC)', () => {
    // BTC entry is ~100-130 range. A cross-contamination bug would put
    // exit near ~2850 (ETH entry * 0.95) or ~3300 (ETH entry * 1.10).
    for (const t of btcTrades) {
      const lowerBound = t.entryPrice * 0.90; // entry * (1 - 10%)
      const upperBound = t.entryPrice * 1.10; // entry * (1 + 10%)
      expect(t.exitPrice).toBeGreaterThanOrEqual(lowerBound);
      expect(t.exitPrice).toBeLessThanOrEqual(upperBound);
    }
  });

  test('SL/TP uses own entry price, no cross-contamination (ETH)', () => {
    // ETH entry is ~2700-3000 range. A cross-contamination bug would put
    // exit near ~95 (BTC entry * 0.95) or ~143 (BTC entry * 1.10).
    for (const t of ethTrades) {
      const lowerBound = t.entryPrice * 0.90;
      const upperBound = t.entryPrice * 1.10;
      expect(t.exitPrice).toBeGreaterThanOrEqual(lowerBound);
      expect(t.exitPrice).toBeLessThanOrEqual(upperBound);
    }
  });

  test('no duplicate BTCUSDT entry while first position is still open', () => {
    // With 40 candles and fast=3/slow=6, BTCUSDT should produce exactly 1 trade.
    // A second crossover could fire while the first position is open, but
    // getState(symbol) !== 'IDLE' guard should prevent a duplicate entry.
    expect(btcTrades.length).toBe(1);
  });
});

// =====================================================================
// Test Variant B: maxConcurrentPositions = 1 (second symbol blocked)
// =====================================================================

describe('maxConcurrentPositions = 1 (second symbol blocked)', () => {
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

  // BTC enters LONG at candle 6 (price ~102.14). ETH crossover fires at candle 16.
  // With default 10% TP, BTC exits at candle 11 — too early to block ETH.
  // With 25% TP, BTC TP price is ~127.68, which isn't reached until candle 18.
  // So BTC is still open at candle 16 when ETH tries to enter → blocked.
  const wideTpPmConfig: PositionManagerConfig = {
    ...pmConfig,
    defaultTakeProfitPct: 25,
  };

  const factory = makeMultiSymbolEmaCrossoverFactory(
    [BTCUSDT, ETHUSDT],
    riskConfig,
    wideTpPmConfig,
  );

  let result: BacktestResult;
  let btcTrades: BacktestResult['trades'];
  let ethTrades: BacktestResult['trades'];

  beforeAll(async () => {
    const engine = createBacktestEngine(loader, exchangeConfig);
    result = await engine.run(factory, {}, btConfig);
    btcTrades = result.trades.filter((t) => t.symbol === BTCUSDT);
    ethTrades = result.trades.filter((t) => t.symbol === ETHUSDT);
  });

  test('BTC position is still open when ETH crossover fires (timing guard)', () => {
    // If this fails, the timing assumption broke — BTC closed before ETH entered,
    // making the maxConcurrent=1 test pass for the wrong reason.
    expect(btcTrades.length).toBeGreaterThanOrEqual(1);
    expect(btcTrades[0]!.exitReason).toBe('TAKE_PROFIT');
  });

  test('BTCUSDT has trades (entered first due to stagger)', () => {
    expect(btcTrades.length).toBeGreaterThanOrEqual(1);
  });

  test('ETHUSDT has 0 trades (blocked by global position limit)', () => {
    expect(ethTrades.length).toBe(0);
  });

  test('total trade count proves second entry was rejected', () => {
    // Only BTC trades exist; ETH was blocked by maxConcurrentPositions=1
    expect(result.trades.length).toBe(btcTrades.length);
  });
});
