/**
 * Bun worker script for parallel sweep engine.
 *
 * Each worker is fully independent:
 * 1. Imports factory from module path
 * 2. Opens own SQLite connection
 * 3. Creates own backtest engine
 * 4. Runs one backtest per message
 * 5. Posts result back
 */

import { createBacktestEngine } from '@trading-bot/backtest-engine';
import type { CandleLoader } from '@trading-bot/backtest-engine';
import { createStorage } from '@trading-bot/storage';
import type { StrategyFactory } from '@trading-bot/strategy';
import type { Timeframe } from '@trading-bot/types';

import type { WorkerRequest, WorkerResponse } from './parallel-types';
import { unsafeCast } from './unsafe-cast';

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
};

self.onmessage = (event: MessageEvent) => {
  void (async () => {
  const msg = unsafeCast<WorkerRequest>(event.data);

  if (msg.type !== 'run') return;

  try {
    // 1. Import factory from module path
    const mod = unsafeCast<Record<string, unknown>>(await import(msg.factoryModulePath));
    const factoryFn = mod[msg.factoryExportName];
    if (typeof factoryFn !== 'function') {
      throw new Error(
        `Export '${msg.factoryExportName}' from '${msg.factoryModulePath}' is not a function`,
      );
    }
    // factoryFn is verified to be a function; the caller guarantees it matches StrategyFactory
    const factory = unsafeCast<StrategyFactory>(factoryFn);

    // 2. Open own SQLite connection for candle loading
    const { candles } = createStorage(msg.dbPath);
    const loader: CandleLoader = (
      symbol: string,
      timeframe: Timeframe,
      startTime: number,
      endTime: number,
    ) => Promise.resolve(candles.getCandles(symbol, timeframe, startTime, endTime));

    // 3. Create engine
    const engine = createBacktestEngine(loader, msg.exchangeConfig);

    // 4. Run backtest
    const result = await engine.run(factory, msg.params, msg.backtestConfig);

    // 5. Post result
    self.postMessage({
      type: 'result',
      params: msg.params,
      result,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      params: msg.params,
      error: err instanceof Error ? err.message : 'Unknown worker error',
    });
  }
  })();
};
