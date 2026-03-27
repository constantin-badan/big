import type { StrategyFactory } from '@trading-bot/strategy';
import type {
  ExchangeConfig,
  PerformanceMetrics,
  Timeframe,
  TradeRecord,
} from '@trading-bot/types';

export interface ArenaConfig {
  exchangeConfig: ExchangeConfig; // live or testnet (for real market data)
  simExchangeConfig: ExchangeConfig; // backtest-sim (for paper fills)
  symbols: string[];
  timeframes: Timeframe[];
  factory: StrategyFactory;
  paramSets: Record<string, number>[]; // N param vectors to run
  evaluationWindowMs: number;
}

export interface ArenaRanking {
  params: Record<string, number>;
  metrics: PerformanceMetrics;
  trades: TradeRecord[];
}

export interface IArena {
  start(): Promise<void>;
  stop(): Promise<void>;
  getRankings(): ArenaRanking[];
  addInstance(params: Record<string, number>): void;
  removeInstance(params: Record<string, number>): void;
}
