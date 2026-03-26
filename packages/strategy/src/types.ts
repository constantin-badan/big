import type { PerformanceMetrics, Signal } from '@trading-bot/types';
import type { IScanner } from '@trading-bot/scanner';
import type { IPositionManager } from '@trading-bot/position-manager';
import type { IRiskManager } from '@trading-bot/risk-manager';

export type SignalBuffer = Map<string, Signal[]>;

export type SignalMerge = (
  trigger: Signal,
  buffer: SignalBuffer,
) => Signal | null;

export interface StrategyConfig {
  name: string;
  symbols: string[];
  scanners: IScanner[];
  signalMerge: SignalMerge;
  signalBufferWindowMs: number;
  positionManager: IPositionManager;
  riskManager: IRiskManager;
}

export interface IStrategy {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStats(): PerformanceMetrics;
}

export type StrategyFactory = (params: Record<string, number>) => IStrategy;

export type SweepParamGrid = Record<string, number[]>;
