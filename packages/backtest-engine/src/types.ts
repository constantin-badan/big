import type { BacktestConfig, BacktestResult, Candle, ExchangeConfig, Timeframe } from '@trading-bot/types';
import type { StrategyFactory } from '@trading-bot/strategy';

// Loads historical candle data for backtest replay.
// Engine calls this for every symbol × timeframe combination in BacktestConfig.
// In tests: async () => fixtures.candles
// In production: reads files, queries DB, or fetches from a REST API
export type CandleLoader = (
  symbol: string,
  timeframe: Timeframe,
  startTime: number,
  endTime: number,
) => Promise<Candle[]>;

export interface IBacktestEngine {
  // Runs a single backtest: creates bus, exchange, executor, replay feed,
  // wires factory deps, pumps candles, collects trades, computes metrics.
  run(
    factory: StrategyFactory,
    params: Record<string, number>,
    config: BacktestConfig,
  ): Promise<BacktestResult>;
}

// Engine is constructed with loader + exchange config — shared across all runs in a sweep
export type CreateBacktestEngine = (
  loader: CandleLoader,
  exchangeConfig: ExchangeConfig,
) => IBacktestEngine;
