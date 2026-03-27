import { EventBus } from '@trading-bot/event-bus';
import { BacktestExecutor } from '@trading-bot/order-executor';
import { ReplayDataFeed } from '@trading-bot/data-feed';
import { computeMetrics } from '@trading-bot/reporting';
import type { BacktestResult, ExchangeConfig, TradeRecord, Candle } from '@trading-bot/types';
import type { CandleLoader, IBacktestEngine } from './types';
import { BacktestSimExchange } from './backtest-sim-exchange';

export function createBacktestEngine(
  loader: CandleLoader,
  exchangeConfig: ExchangeConfig,
): IBacktestEngine {
  if (exchangeConfig.type !== 'backtest-sim') {
    throw new Error(`createBacktestEngine requires 'backtest-sim' config, got '${exchangeConfig.type}'`);
  }

  const { feeStructure, slippageModel, initialBalance } = exchangeConfig;

  return {
    async run(factory, params, config) {
      // 1. Create event bus
      const bus = new EventBus();

      // 2. Create sim exchange
      const exchange = new BacktestSimExchange(bus, { feeStructure, slippageModel, initialBalance });

      // 3. Create backtest executor
      const executor = new BacktestExecutor(bus, exchange);

      // 4. Load candles for each symbol × timeframe
      const candleMap = new Map<string, Candle[]>();
      for (const symbol of config.symbols) {
        for (const tf of config.timeframes) {
          const candles = await loader(symbol, tf, config.startTime, config.endTime);
          candleMap.set(`${symbol}:${tf}`, candles);
        }
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
