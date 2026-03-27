import type { StrategyFactory } from '@trading-bot/strategy';
import type { TradeRecord } from '@trading-bot/types';

export interface ParityMatchedPair {
  live: TradeRecord;
  backtest: TradeRecord;
  entryPriceDiffBps: number; // positive = live paid more
  exitPriceDiffBps: number;
  pnlDiff: number;
  slippageDiff: number;
  feeDiff: number;
  exitReasonMatch: boolean;
}

export interface ParitySummary {
  matchRate: number;
  meanEntryDeviationBps: number;
  meanPnlDeviation: number;
  pnlCorrelation: number;
  backtestOverestimatesPnl: boolean;
}

export interface ParityResult {
  period: { startTime: number; endTime: number };
  matched: ParityMatchedPair[];
  liveOnly: TradeRecord[];
  backtestOnly: TradeRecord[];
  summary: ParitySummary;
}

export interface IParityChecker {
  compare(
    strategyName: string,
    factory: StrategyFactory,
    params: Record<string, number>,
    period: { startTime: number; endTime: number },
  ): Promise<ParityResult>;
}
