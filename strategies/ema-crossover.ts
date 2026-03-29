/**
 * EMA Crossover Strategy Factory
 *
 * Detects bullish/bearish crossovers between fast and slow EMAs.
 * Coin-agnostic — works on any symbol, any timeframe.
 *
 * Params (via sweep grid):
 *   fastPeriod: number (default 5)
 *   slowPeriod: number (default 10)
 *
 * The factory is parameterized by symbols, risk config, and PM config.
 * The EMA periods come from the params object so they can be swept.
 */
import { createEMA } from '@trading-bot/indicators';
import { PositionManager } from '@trading-bot/position-manager';
import { RiskManager } from '@trading-bot/risk-manager';
import { createScannerFactory } from '@trading-bot/scanner';
import { Strategy, passthroughMerge } from '@trading-bot/strategy';
import type {
  PositionManagerConfig,
  RiskConfig,
  ScannerEvaluate,
  StrategyFactory,
  Symbol,
  Timeframe,
} from '@trading-bot/types';

export function createEmaCrossoverFactory(
  symbols: Symbol[],
  timeframe: Timeframe,
  riskConfig: RiskConfig,
  pmConfig: PositionManagerConfig,
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
      symbols,
      timeframe,
      indicators: {
        fast: () => createEMA({ period: fastPeriod }),
        slow: () => createEMA({ period: slowPeriod }),
      },
    });

    const riskManager = new RiskManager(deps.bus, riskConfig);
    const positionManager = new PositionManager(deps.bus, deps.executor, riskManager, pmConfig);

    return new Strategy(
      {
        name: `ema-cross-${String(fastPeriod)}-${String(slowPeriod)}`,
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
