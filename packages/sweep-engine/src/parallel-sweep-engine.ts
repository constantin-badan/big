import type { SweepParamGrid } from '@trading-bot/strategy';

import type {
  IParallelSweepEngine,
  ParallelSweepConfig,
  ParallelSweepResult,
  WorkerRequest,
  WorkerResponse,
} from './parallel-types';
import { BUILT_IN_SCORERS } from './parallel-types';
import type { SweepResult, SweepScorer } from './types';
import { unsafeCast } from './unsafe-cast';

function cartesianProduct(grid: SweepParamGrid): Record<string, number>[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [];

  let combos: Record<string, number>[] = [{}];

  for (const key of keys) {
    const values = grid[key];
    if (values === undefined || values.length === 0) return [];
    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [key]: value });
      }
    }
    combos = next;
  }

  return combos;
}

export function createParallelSweepEngine(config: ParallelSweepConfig): IParallelSweepEngine {
  const maxConcurrency = config.maxConcurrency ?? navigator.hardwareConcurrency ?? 4;
  const scorerName = config.scorer ?? 'profitFactor';
  const scorer: SweepScorer = BUILT_IN_SCORERS[scorerName];
  const factoryExportName = config.factoryExportName ?? 'factory';

  return {
    async run(grid: SweepParamGrid): Promise<ParallelSweepResult> {
      const paramSets = cartesianProduct(grid);
      if (paramSets.length === 0) return { results: [], errors: [] };

      const results: SweepResult[] = [];
      const errors: Array<{ params: Record<string, number>; error: string }> = [];
      let nextIndex = 0;

      const workerUrl = new URL('./sweep-worker.ts', import.meta.url).href;

      return new Promise((resolve, reject) => {
        const activeWorkers = new Set<Worker>();
        let completed = 0;

        function spawnWorker(): void {
          if (nextIndex >= paramSets.length) return;

          const params = paramSets[nextIndex]!;
          nextIndex++;

          const worker = new Worker(workerUrl);
          activeWorkers.add(worker);

          worker.onmessage = (event: MessageEvent) => {
            const response = unsafeCast<WorkerResponse>(event.data);
            activeWorkers.delete(worker);
            worker.terminate();

            if (response.type === 'result' && response.result) {
              results.push({ params: response.params, result: response.result });
            } else if (response.type === 'error') {
              errors.push({ params: response.params, error: response.error ?? 'Unknown error' });
            }

            completed++;

            if (completed === paramSets.length) {
              if (errors.length > 0 && results.length === 0) {
                reject(new Error(`All sweep runs failed. First error: ${errors[0]?.error}`));
                return;
              }

              // Sort by scorer descending
              results.sort((a, b) => {
                const scoreA = scorer(a.result);
                const scoreB = scorer(b.result);
                if (scoreA === scoreB) return 0;
                if (scoreA === Infinity) return -1;
                if (scoreB === Infinity) return 1;
                return scoreB - scoreA;
              });

              resolve({ results, errors });
            } else {
              // Spawn next worker
              spawnWorker();
            }
          };

          worker.onerror = () => {
            activeWorkers.delete(worker);
            worker.terminate();
            errors.push({ params, error: 'Worker crashed' });
            completed++;

            if (completed === paramSets.length) {
              if (results.length === 0) {
                reject(new Error(`All sweep runs failed. First error: ${errors[0]?.error}`));
              } else {
                results.sort((a, b) => scorer(b.result) - scorer(a.result));
                resolve({ results, errors });
              }
            } else {
              spawnWorker();
            }
          };

          const request: WorkerRequest = {
            type: 'run',
            params,
            factoryModulePath: config.factoryModulePath,
            factoryExportName,
            backtestConfig: config.backtestConfig,
            exchangeConfig: config.exchangeConfig,
            dbPath: config.dbPath,
          };

          worker.postMessage(request);
        }

        // Spawn initial batch of workers
        const initialCount = Math.min(maxConcurrency, paramSets.length);
        for (let i = 0; i < initialCount; i++) {
          spawnWorker();
        }
      });
    },
  };
}
