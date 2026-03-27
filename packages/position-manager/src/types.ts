import type { OrderType, Position } from '@trading-bot/types';

export interface PositionManagerConfig {
  defaultStopLossPct: number;
  defaultTakeProfitPct: number;
  trailingStopEnabled: boolean;
  trailingStopActivationPct: number;
  trailingStopDistancePct: number;
  maxHoldTimeMs: number;
  entryOrderType: OrderType; // default: MARKET — LIMIT for mean-reversion strategies
  safetyStopEnabled: boolean; // default: false — exchange-side STOP_MARKET as crash net (Phase 3a-hardened)
  safetyStopMultiplier: number; // default: 2.0 — placed at 2× normal SL distance
}

export type PositionState = 'IDLE' | 'PENDING_ENTRY' | 'OPEN' | 'PENDING_EXIT';

export interface IPositionManager {
  getState(symbol: string): PositionState;
  hasOpenPosition(symbol: string): boolean;
  hasPendingOrder(symbol: string): boolean;
  getOpenPositions(): Position[];
  dispose(): void;
}
