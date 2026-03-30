import { ReplayDataFeed } from '@trading-bot/data-feed';
import { EventBus } from '@trading-bot/event-bus';
import { BacktestExecutor } from '@trading-bot/order-executor';
import { computeMetrics } from '@trading-bot/reporting';
import type { BacktestResult, ExchangeConfig, TradeRecord, Candle } from '@trading-bot/types';

import { BacktestSimExchange } from './backtest-sim-exchange';
import type { CandleLoader, IBacktestEngine } from './types';

export function createBacktestEngine(
  loader: CandleLoader,
  exchangeConfig: ExchangeConfig,
): IBacktestEngine {
  if (exchangeConfig.type !== 'backtest-sim') {
    throw new Error(
      `createBacktestEngine requires 'backtest-sim' config, got '${exchangeConfig.type}'`,
    );
  }

  const { feeStructure, slippageModel, initialBalance, defaultLeverage } = exchangeConfig;

  if (slippageModel.type !== 'fixed') {
    throw new Error(`Backtest engine only supports 'fixed' slippage model, got '${slippageModel.type}'`);
  }

  return {
    async run(factory, params, config) {
      if (config.startTime >= config.endTime) {
        throw new Error(`Backtest: startTime must be < endTime`);
      }
      if (config.symbols.length === 0) {
        throw new Error(`Backtest: symbols must not be empty`);
      }
      if (config.timeframes.length === 0) {
        throw new Error(`Backtest: timeframes must not be empty`);
      }

      // 1. Create event bus
      const bus = new EventBus();

      // 2. Create sim exchange
      const exchange = new BacktestSimExchange(bus, {
        feeStructure,
        slippageModel,
        initialBalance,
        leverage: defaultLeverage ?? 1,
      });

      // 3. Create backtest executor
      const executor = new BacktestExecutor(bus, exchange);

      // 4. Load candles for each symbol × timeframe (parallelised)
      //    Load extra candles before startTime so indicators can warm up.
      const warmupMs = config.warmupMs ?? 0;
      const loadStart = config.startTime - warmupMs;
      const candleMap = new Map<string, Candle[]>();
      const loadJobs = config.symbols.flatMap((symbol) =>
        config.timeframes.map(async (tf) => {
          const candles = await loader(symbol, tf, loadStart, config.endTime);
          return { key: `${symbol}:${tf}`, candles };
        }),
      );
      for (const { key, candles } of await Promise.all(loadJobs)) {
        candleMap.set(key, candles);
      }

      // 5. Split candles into warmup and real periods
      const warmupCandleMap = new Map<string, Candle[]>();
      const realCandleMap = new Map<string, Candle[]>();
      for (const [key, candles] of candleMap) {
        if (warmupMs > 0) {
          warmupCandleMap.set(key, candles.filter((c) => c.closeTime < config.startTime));
          realCandleMap.set(key, candles.filter((c) => c.closeTime >= config.startTime));
        } else {
          realCandleMap.set(key, candles);
        }
      }

      // 6. Collect trades from position:closed events
      const trades: TradeRecord[] = [];
      const tradeHandler = (data: { trade: TradeRecord }) => {
        trades.push(data.trade);
      };
      bus.on('position:closed', tradeHandler);

      // 7. Create strategy via factory
      const strategy = factory(params, { bus, exchange, executor });

      // 8. Run warmup + real replay with guaranteed cleanup
      let strategyStarted = false;
      try {
        await strategy.start();
        strategyStarted = true;

        // Phase 1: replay warmup candles (indicators warm up)
        if (warmupMs > 0) {
          const warmupFeed = new ReplayDataFeed(bus, warmupCandleMap);
          await warmupFeed.start(config.symbols, config.timeframes);

          // Reset PM, risk, exchange — start real period clean
          strategy.resetState();
          exchange.resetBalance(initialBalance);
          trades.length = 0;
        }

        // Phase 2: replay real candles
        const realFeed = new ReplayDataFeed(bus, realCandleMap);
        await realFeed.start(config.symbols, config.timeframes);
      } finally {
        if (strategyStarted) {
          try {
            await strategy.stop();
          } catch {
            /* stop failed — cleanup continues */
          }
        }
        bus.off('position:closed', tradeHandler);
        exchange.dispose();
      }

      // 9. All trades are from the real period
      const validTrades = trades;

      // 12. Compute metrics and return result
      const metrics = computeMetrics(
        validTrades,
        config.timeframes,
        initialBalance,
        config.startTime,
        config.endTime,
      );

      // Compute final balance from closed trades only.
      // The exchange's internal balance includes unreturned notional from open positions,
      // which would incorrectly show as a loss. Trade-based PnL is the correct measure.
      let finalBalance = initialBalance;
      for (const t of validTrades) {
        finalBalance += t.pnl;
      }

      const result: BacktestResult = {
        trades: validTrades,
        startTime: config.startTime,
        endTime: config.endTime,
        initialBalance,
        finalBalance,
        metrics,
      };

      return result;
    },
  };
}
