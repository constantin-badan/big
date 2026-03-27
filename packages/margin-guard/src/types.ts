export interface MarginGuardConfig {
  maxUnrealizedLossPct: number;      // e.g., 10 — kill if total unrealized loss exceeds 10% of balance
  maxTotalExposurePct: number;       // e.g., 50 — kill if total notional > 50% of balance
  evaluationEvent: 'tick' | 'candle:close';  // tick for live, candle:close for backtest
  balance: number;                   // account balance for pct calculations
}

export interface IMarginGuard {
  readonly isBreached: boolean;
  dispose(): void;
}
