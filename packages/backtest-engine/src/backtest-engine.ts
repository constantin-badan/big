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

  return {
    async run(factory, params, config) {
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
      const candleMap = new Map<string, Candle[]>();
      const loadJobs = config.symbols.flatMap((symbol) =>
        config.timeframes.map(async (tf) => {
          const candles = await loader(symbol, tf, config.startTime, config.endTime);
          return { key: `${symbol}:${tf}`, candles };
        }),
      );
      for (const { key, candles } of await Promise.all(loadJobs)) {
        candleMap.set(key, candles);
      }

      // 5. Create replay data feed
      const dataFeed = new ReplayDataFeed(bus, candleMap);

      // 6. Collect trades from position:closed events
      const trades: TradeRecord[] = [];
      const tradeHandler = (data: { trade: TradeRecord }) => {
        trades.push(data.trade);
      };
      bus.on('position:closed', tradeHandler);

      // 7. Create strategy via factory
      const strategy = factory(params, { bus, exchange, executor });

      // 8-10. Run strategy with guaranteed cleanup
      try {
        await strategy.start();
        await dataFeed.start(config.symbols, config.timeframes);
        await strategy.stop();
      } finally {
        bus.off('position:closed', tradeHandler);
        exchange.dispose();
      }

      // 11. Compute metrics and return result
      const metrics = computeMetrics(
        trades,
        config.timeframes,
        initialBalance,
        config.startTime,
        config.endTime,
      );

      let finalBalance = initialBalance;
      for (const trade of trades) {
        finalBalance += trade.pnl;
      }

      const result: BacktestResult = {
        trades,
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
