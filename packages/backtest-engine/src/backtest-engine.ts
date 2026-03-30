import { ReplayDataFeed } from '@trading-bot/data-feed';
import { EventBus } from '@trading-bot/event-bus';
import { BacktestExecutor } from '@trading-bot/order-executor';
import { computeMetrics } from '@trading-bot/reporting';
import type { BacktestResult, ExchangeConfig, TradeRecord, Candle, Position, Symbol } from '@trading-bot/types';

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

      // 5. Create replay data feed
      const dataFeed = new ReplayDataFeed(bus, candleMap);

      // 6. Collect trades from position:closed events
      const trades: TradeRecord[] = [];
      const tradeHandler = (data: { trade: TradeRecord }) => {
        trades.push(data.trade);
      };
      bus.on('position:closed', tradeHandler);

      // 6b. Track equity on every candle:close for accurate drawdown
      //     equity = exchange balance + mark-to-market value of open positions
      const openPositions = new Map<Symbol, { side: 'BUY' | 'SELL'; quantity: number; entryPrice: number }>();
      const equityCurve: Array<{ time: number; equity: number }> = [];

      const posOpenHandler = (data: { position: Position }) => {
        openPositions.set(data.position.symbol, {
          side: data.position.side === 'LONG' ? 'BUY' : 'SELL',
          quantity: data.position.quantity,
          entryPrice: data.position.entryPrice,
        });
      };
      const posCloseHandler = (data: { position: Position }) => {
        openPositions.delete(data.position.symbol);
      };
      const equityHandler = (data: { candle: Candle }) => {
        // Only track equity after warmup period
        if (data.candle.closeTime < config.startTime) return;

        let unrealizedPnl = 0;
        for (const [sym, pos] of openPositions) {
          const price = exchange.getCurrentPrice(sym);
          if (price === undefined) continue;
          const direction = pos.side === 'BUY' ? 1 : -1;
          unrealizedPnl += (price - pos.entryPrice) * direction * pos.quantity;
        }
        equityCurve.push({
          time: data.candle.closeTime,
          equity: exchange.getBalanceSync() + unrealizedPnl,
        });
      };

      bus.on('position:opened', posOpenHandler);
      bus.on('position:closed', posCloseHandler);
      bus.on('candle:close', equityHandler);

      // 7. Create strategy via factory
      const strategy = factory(params, { bus, exchange, executor });

      // 8-10. Run strategy with guaranteed cleanup
      let strategyStarted = false;
      try {
        await strategy.start();
        strategyStarted = true;
        await dataFeed.start(config.symbols, config.timeframes);
      } finally {
        if (strategyStarted) {
          try {
            await strategy.stop();
          } catch {
            /* stop failed — cleanup continues */
          }
        }
        bus.off('position:closed', tradeHandler);
        bus.off('position:opened', posOpenHandler);
        bus.off('position:closed', posCloseHandler);
        bus.off('candle:close', equityHandler);
        exchange.dispose();
      }

      // 11. Discard trades that entered during the warmup period
      const validTrades = warmupMs > 0
        ? trades.filter((t) => t.entryTime >= config.startTime)
        : trades;

      // 12. Compute metrics and return result (equity curve enables accurate intra-trade drawdown)
      const metrics = computeMetrics(
        validTrades,
        config.timeframes,
        initialBalance,
        config.startTime,
        config.endTime,
        equityCurve,
      );

      // Use the exchange's internal balance as authoritative source of truth.
      // This accounts for fees and slippage that the exchange applied during fills.
      const balances = await exchange.getBalance();
      const finalBalance = balances[0]?.total ?? initialBalance;

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
