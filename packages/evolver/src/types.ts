import type { ArenaRanking } from '@trading-bot/arena';
import type { ParamBounds, PerformanceMetrics } from '@trading-bot/types';

export type { ParamSpec, ParamBounds } from '@trading-bot/types';

// Scoring function for ranking arena instances. Higher score = better.
// Takes an ArenaRanking (params + metrics + trades) and returns a numeric score.
export type EvolverScorer = (ranking: ArenaRanking) => number;

export interface EvolverConfig {
  paramBounds: ParamBounds;
  populationSize: number;
  survivalRate: number; // 0.5 = keep top 50%
  mutationRate: number; // 0.1 = 10% perturbation
  eliteCount: number; // 1 = top 1 survives unmutated
  evaluationWindowMs: number; // passed through to arena
  stagnationGenerations: number; // widen mutation after N flat generations
  stagnationMutationRate: number; // wider rate during stagnation (e.g., 0.3)
  scorer: EvolverScorer;
}

export interface IEvolver {
  start(initialParams: Record<string, number>[]): Promise<void>;
  stop(): Promise<void>;
  readonly generation: number;
  readonly bestParams: Record<string, number>;
  readonly bestMetrics: PerformanceMetrics;
  onGenerationComplete(cb: (rankings: ArenaRanking[]) => void): void;
}
