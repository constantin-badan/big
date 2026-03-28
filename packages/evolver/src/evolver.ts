import type { ArenaRanking, IArena } from '@trading-bot/arena';
import type { PerformanceMetrics } from '@trading-bot/types';

import { mutateParams } from './mutation';
import type { EvolverConfig, IEvolver } from './types';

const ZERO_METRICS: PerformanceMetrics = {
  totalTrades: 0,
  winRate: 0,
  profitFactor: 0,
  sharpeRatio: 0,
  maxDrawdown: 0,
  maxDrawdownDuration: 0,
  avgWin: 0,
  avgLoss: 0,
  expectancy: 0,
  avgHoldTime: 0,
  totalFees: 0,
  totalSlippage: 0,
};

function paramsKey(params: Record<string, number>): string {
  const entries = Object.entries(params).sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

export class Evolver implements IEvolver {
  private readonly config: EvolverConfig;
  private readonly arena: IArena;

  private _generation = 0;
  private _bestParams: Record<string, number> = {};
  private _bestMetrics: PerformanceMetrics = ZERO_METRICS;
  private _bestScore = -Infinity;
  private _stagnationCount = 0;

  private running = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: Array<(rankings: ArenaRanking[]) => void> = [];
  private currentPopulation: Record<string, number>[] = [];

  constructor(arena: IArena, config: EvolverConfig) {
    this.arena = arena;
    this.config = config;
  }

  get generation(): number {
    return this._generation;
  }

  get bestParams(): Record<string, number> {
    return this._bestParams;
  }

  get bestMetrics(): PerformanceMetrics {
    return this._bestMetrics;
  }

  onGenerationComplete(cb: (rankings: ArenaRanking[]) => void): void {
    this.callbacks.push(cb);
  }

  async start(initialParams: Record<string, number>[]): Promise<void> {
    if (this.running) return;

    if (initialParams.length === 0) {
      throw new Error('Evolver: initialParams must not be empty');
    }

    this.running = true;
    this._generation = 0;
    this._bestScore = -Infinity;
    this._stagnationCount = 0;

    // Build initial population:
    // Use provided params, fill remaining slots with mutations of the provided params
    this.currentPopulation = this.buildInitialPopulation(initialParams);

    // Start arena with initial population
    for (const params of this.currentPopulation) {
      this.arena.addInstance(params);
    }
    await this.arena.start();

    // Start the evolution loop
    this.scheduleNextGeneration();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.loopTimer !== null) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }

    await this.arena.stop();
  }

  private buildInitialPopulation(
    initialParams: Record<string, number>[],
  ): Record<string, number>[] {
    const population: Record<string, number>[] = [];
    const seen = new Set<string>();

    // Add all provided initial params (up to populationSize)
    for (const params of initialParams) {
      if (population.length >= this.config.populationSize) break;
      const key = paramsKey(params);
      if (!seen.has(key)) {
        seen.add(key);
        population.push({ ...params });
      }
    }

    // Fill remaining slots with mutations of initial params
    let sourceIdx = 0;
    while (population.length < this.config.populationSize) {
      const sourceParams = initialParams[sourceIdx % initialParams.length]!;
      const mutated = mutateParams(sourceParams, this.config.paramBounds, this.config.mutationRate);
      const key = paramsKey(mutated);
      if (!seen.has(key)) {
        seen.add(key);
        population.push(mutated);
      }
      sourceIdx++;
      // Safety: avoid infinite loop if mutation keeps producing duplicates
      if (sourceIdx > this.config.populationSize * 100) break;
    }

    return population;
  }

  private scheduleNextGeneration(): void {
    if (!this.running) return;

    this.loopTimer = setTimeout(() => {
      if (!this.running) return;
      this.evolve().catch(() => {
        this.running = false;
        this.loopTimer = null;
      });
    }, this.config.evaluationWindowMs);
  }

  private async evolve(): Promise<void> {
    if (!this.running) return;

    this._generation++;

    // 1. Get rankings from arena and score them
    const rankings = this.arena.getRankings();

    // Score and sort by scorer (descending)
    const scored = rankings
      .map((r) => ({ ranking: r, score: this.config.scorer(r) }))
      .sort((a, b) => b.score - a.score);

    // 2. Update best params and detect stagnation
    const topScore = scored[0]?.score ?? -Infinity;
    const topRanking = scored[0]?.ranking;

    if (topScore > this._bestScore) {
      this._bestScore = topScore;
      this._stagnationCount = 0;
      if (topRanking !== undefined) {
        this._bestParams = { ...topRanking.params };
        this._bestMetrics = topRanking.metrics;
      }
    } else {
      this._stagnationCount++;
    }

    // 3. Notify callbacks
    for (const cb of this.callbacks) {
      cb(rankings);
    }

    // 4. Determine survivors and casualties
    const survivorCount = Math.max(
      this.config.eliteCount,
      Math.floor(scored.length * this.config.survivalRate),
    );

    const survivors = scored.slice(0, survivorCount);
    const casualties = scored.slice(survivorCount);

    // 5. Remove casualties from arena
    for (const c of casualties) {
      this.arena.removeInstance(c.ranking.params);
    }

    // 6. Determine effective mutation rate (widen during stagnation)
    const effectiveMutationRate =
      this._stagnationCount >= this.config.stagnationGenerations
        ? this.config.stagnationMutationRate
        : this.config.mutationRate;

    // 7. Create new population
    const newPopulation: Record<string, number>[] = [];
    const seen = new Set<string>();

    // Elite survive unmutated (but arena resets their stats via remove+add)
    for (let i = 0; i < Math.min(this.config.eliteCount, survivors.length); i++) {
      const elite = survivors[i]!;
      const key = paramsKey(elite.ranking.params);
      seen.add(key);
      newPopulation.push({ ...elite.ranking.params });

      // Reset elite stats by removing and re-adding
      this.arena.removeInstance(elite.ranking.params);
      this.arena.addInstance(elite.ranking.params);
    }

    // Non-elite survivors get mutated
    for (let i = this.config.eliteCount; i < survivors.length; i++) {
      const survivor = survivors[i]!;
      const mutated = mutateParams(
        survivor.ranking.params,
        this.config.paramBounds,
        effectiveMutationRate,
      );
      const key = paramsKey(mutated);
      if (!seen.has(key)) {
        seen.add(key);
        newPopulation.push(mutated);
      }

      // Remove old instance and add mutated version
      this.arena.removeInstance(survivor.ranking.params);
      this.arena.addInstance(mutated);
    }

    // 8. Fill slots vacated by casualties with mutations of survivors
    if (survivors.length === 0) {
      this.scheduleNextGeneration();
      return;
    }
    let fillIdx = 0;
    while (newPopulation.length < this.config.populationSize) {
      const sourceIdx = fillIdx % survivors.length;
      const source = survivors[sourceIdx]!;
      const mutated = mutateParams(
        source.ranking.params,
        this.config.paramBounds,
        effectiveMutationRate,
      );
      const key = paramsKey(mutated);
      if (!seen.has(key)) {
        seen.add(key);
        newPopulation.push(mutated);
        this.arena.addInstance(mutated);
      }
      fillIdx++;

      // Safety: avoid infinite loop if mutation keeps producing duplicates
      if (fillIdx > this.config.populationSize * 100) break;
    }

    this.currentPopulation = newPopulation;

    // 9. Schedule next generation
    this.scheduleNextGeneration();
  }
}
