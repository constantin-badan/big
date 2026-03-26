import type { Position } from '@trading-bot/types';

export interface PositionManagerConfig {
  defaultStopLossPct: number;
  defaultTakeProfitPct: number;
  trailingStopEnabled: boolean;
  trailingStopActivationPct: number;
  trailingStopDistancePct: number;
  maxHoldTimeMs: number;
}

export type PositionState = 'IDLE' | 'PENDING_ENTRY' | 'OPEN' | 'PENDING_EXIT';

export interface IPositionManager {
  getState(symbol: string): PositionState;
  hasOpenPosition(symbol: string): boolean;
  hasPendingOrder(symbol: string): boolean;
  getOpenPositions(): Position[];
  dispose(): void;
}
