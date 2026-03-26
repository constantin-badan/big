import type { RiskRule, RiskSeverity, Signal } from '@trading-bot/types';

export interface RiskConfig {
  maxPositionSizePct: number;
  maxConcurrentPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxDailyTrades: number;
  cooldownAfterLossMs: number;
}

export type RiskCheckResult =
  | { allowed: true }
  | { allowed: false; rule: RiskRule; reason: string; severity: RiskSeverity };

export interface IRiskManager {
  checkEntry(signal: Signal): RiskCheckResult;
  isKillSwitchActive(): boolean;
  reset(): void;
  dispose(): void;
}
