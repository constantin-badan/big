import type { RiskCheckResult, Signal } from '@trading-bot/types';

export interface RiskConfig {
  maxPositionSizePct: number;
  maxConcurrentPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxDailyTrades: number;
  cooldownAfterLossMs: number;
  leverage: number; // default 1 for spot; quantity = balance * pct * leverage / price
  initialBalance: number; // balance tracked internally via position:closed PnL
}

export interface IRiskManager {
  checkEntry(signal: Signal, entryPrice: number): RiskCheckResult;
  isKillSwitchActive(): boolean;
  reset(): void;
  dispose(): void;
}
