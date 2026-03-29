import type { IExchange } from '@trading-bot/exchange-client';
import type { IMarginGuard } from '@trading-bot/margin-guard';
import type { IOrderExecutor } from '@trading-bot/order-executor';
import type { IPositionManager } from '@trading-bot/position-manager';
import type { IRiskManager } from '@trading-bot/risk-manager';
import type { IScanner } from '@trading-bot/scanner';
import type { IEventBus, PerformanceMetrics, Signal, Symbol } from '@trading-bot/types';

export type SignalBuffer = Map<string, Signal[]>;

export type SignalMerge = (trigger: Signal, buffer: SignalBuffer) => Signal | null;

export interface StrategyConfig {
  name: string;
  symbols: Symbol[];
  scanners: IScanner[];
  signalMerge: SignalMerge;
  signalBufferWindowMs: number;
  positionManager: IPositionManager;
  riskManager: IRiskManager;
  marginGuard?: IMarginGuard;
}

export interface IStrategy {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  // Live-only — returns running performance metrics during live trading.
  // In backtest mode, results come from BacktestResult. Returns stub zeros in Phase 2.
  getStats(): PerformanceMetrics;
}

// Runner-provided environment — differs between backtest and live.
// The factory builds strategy-specific components (scanners, risk, position mgr)
// wired to these deps. It does NOT create bus, exchange, or executor.
export interface StrategyDeps {
  bus: IEventBus;
  exchange: IExchange;
  executor: IOrderExecutor;
}

export type StrategyFactory = (params: Record<string, number>, deps: StrategyDeps) => IStrategy;

export type SweepParamGrid = Record<string, number[]>;
