import type {
  ExchangeConfig,
  PerformanceMetrics,
  StrategyFactory,
  Symbol,
  Timeframe,
  TradeRecord,
} from '@trading-bot/types';

export interface ArenaConfig {
  exchangeConfig: ExchangeConfig; // live or testnet (for real market data)
  simExchangeConfig: ExchangeConfig; // backtest-sim (for paper fills)
  symbols: Symbol[];
  timeframes: Timeframe[];
  factory: StrategyFactory;
  paramSets: Record<string, number>[]; // N param vectors to run
  evaluationWindowMs: number;
  maxGlobalPositions?: number; // total open positions across all instances
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
