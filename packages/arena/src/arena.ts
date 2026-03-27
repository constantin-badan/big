import { BacktestSimExchange } from '@trading-bot/backtest-engine';
import { LiveDataFeed } from '@trading-bot/data-feed';
import { EventBus } from '@trading-bot/event-bus';
import type { IEventBus, TradingEventMap } from '@trading-bot/event-bus';
import { createExchange } from '@trading-bot/exchange-client';
import type { IExchange } from '@trading-bot/exchange-client';
import { BacktestExecutor } from '@trading-bot/order-executor';
import { computeMetrics } from '@trading-bot/reporting';
import type { IOrderExecutor } from '@trading-bot/order-executor';
import type { IStrategy } from '@trading-bot/strategy';
import type { ExchangeConfig, OrderRequest, SubmissionReceipt, TradeRecord } from '@trading-bot/types';

import type { ArenaConfig, ArenaRanking, IArena } from './types';

// Events forwarded from the source bus to each strategy bus
const FORWARDED_EVENTS = ['candle:close', 'candle:update', 'tick'] as const;
type ForwardedEvent = (typeof FORWARDED_EVENTS)[number];

function paramsKey(params: Record<string, number>): string {
  const entries = Object.entries(params).sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

interface ArenaInstance {
  params: Record<string, number>;
  bus: IEventBus;
  simExchange: BacktestSimExchange;
  executor: IOrderExecutor;
  strategy: IStrategy;
  trades: TradeRecord[];
  tradeHandler: (data: TradingEventMap['position:closed']) => void;
  positionHandler: (data: TradingEventMap['position:opened']) => void;
  positionClosedHandler: (data: TradingEventMap['position:closed']) => void;
  forwarders: Array<() => void>;
}

interface SimExchangeParams {
  feeStructure: { maker: number; taker: number };
  slippageModel: { type: 'fixed' | 'proportional' | 'orderbook-based'; fixedBps?: number };
  initialBalance: number;
  leverage: number;
}

function extractSimConfig(config: ExchangeConfig): SimExchangeParams {
  if (config.type !== 'backtest-sim') {
    throw new Error(`Arena: simExchangeConfig must be 'backtest-sim', got '${config.type}'`);
  }
  return {
    feeStructure: config.feeStructure,
    slippageModel: config.slippageModel,
    initialBalance: config.initialBalance,
    leverage: config.defaultLeverage ?? 1,
  };
}

export class Arena implements IArena {
  private readonly config: ArenaConfig;
  private readonly instances = new Map<string, ArenaInstance>();
  private exchange: IExchange | null = null;
  private sourceBus: IEventBus | null = null;
  private dataFeed: LiveDataFeed | null = null;
  private running = false;

  // Global position budget across all instances
  private globalOpenPositions = 0;

  constructor(config: ArenaConfig) {
    if (config.simExchangeConfig.type !== 'backtest-sim') {
      throw new Error(
        `Arena: simExchangeConfig must be 'backtest-sim', got '${config.simExchangeConfig.type}'`,
      );
    }
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.running) return;

    // 1. Create exchange connection for real market data
    this.exchange = createExchange(this.config.exchangeConfig);
    await this.exchange.connect();

    // 2. Create source bus and LiveDataFeed
    this.sourceBus = new EventBus();
    this.dataFeed = new LiveDataFeed(this.sourceBus, this.exchange);

    // 3. Create instances for each param set
    for (const params of this.config.paramSets) {
      this.createInstance(params);
    }

    // 4. Start LiveDataFeed (subscribes to exchange streams)
    await this.dataFeed.start(this.config.symbols, this.config.timeframes);

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // 1. Stop data feed
    if (this.dataFeed !== null) {
      await this.dataFeed.stop();
    }

    // 2. Stop all instances
    for (const [key, instance] of this.instances) {
      await this.destroyInstance(instance);
      this.instances.delete(key);
    }

    // 3. Disconnect exchange
    if (this.exchange !== null) {
      await this.exchange.disconnect();
    }

    this.exchange = null;
    this.sourceBus = null;
    this.dataFeed = null;
    this.globalOpenPositions = 0;
  }

  getRankings(): ArenaRanking[] {
    const simCfg = extractSimConfig(this.config.simExchangeConfig);
    const rankings: ArenaRanking[] = [];

    for (const instance of this.instances.values()) {
      const now = Date.now();
      const windowStart = now - this.config.evaluationWindowMs;
      const tradesInWindow = instance.trades.filter((t) => t.exitTime >= windowStart);

      const metrics = computeMetrics(
        tradesInWindow,
        this.config.timeframes,
        simCfg.initialBalance,
        windowStart,
        now,
      );

      rankings.push({
        params: instance.params,
        metrics,
        trades: tradesInWindow,
      });
    }

    // Sort by Sharpe ratio descending
    rankings.sort((a, b) => b.metrics.sharpeRatio - a.metrics.sharpeRatio);

    return rankings;
  }

  addInstance(params: Record<string, number>): void {
    const key = paramsKey(params);
    if (this.instances.has(key)) return;
    this.createInstance(params);
  }

  removeInstance(params: Record<string, number>): void {
    const key = paramsKey(params);
    const instance = this.instances.get(key);
    if (instance === undefined) return;
    this.instances.delete(key);

    // Immediately stop event flow (all synchronous)
    for (const dispose of instance.forwarders) {
      dispose();
    }
    instance.bus.off('position:closed', instance.tradeHandler);
    instance.bus.off('position:opened', instance.positionHandler);
    instance.bus.off('position:closed', instance.positionClosedHandler);
    instance.simExchange.dispose();

    // Strategy stop is async — fire-and-forget with error boundary
    instance.strategy.stop().catch(() => {
      // Strategy stop failed — event flow already cleaned up above
    });
  }

  private createInstance(params: Record<string, number>): void {
    const key = paramsKey(params);
    if (this.instances.has(key)) return;

    const simCfg = extractSimConfig(this.config.simExchangeConfig);

    // Each instance gets its own isolated bus
    const bus = new EventBus();

    // Create sim exchange on this bus (listens for candle:close to track prices)
    const simExchange = new BacktestSimExchange(bus, {
      feeStructure: simCfg.feeStructure,
      slippageModel: simCfg.slippageModel,
      initialBalance: simCfg.initialBalance,
      leverage: simCfg.leverage,
    });

    // Create executor wired to this bus and sim exchange
    const rawExecutor = new BacktestExecutor(bus, simExchange);

    // Wrap executor with global position budget enforcement
    const executor: IOrderExecutor = this.config.maxGlobalPositions !== undefined
      ? this.wrapExecutorWithBudget(rawExecutor, bus)
      : rawExecutor;

    // Collect trades from position:closed events
    const trades: TradeRecord[] = [];
    const tradeHandler = (data: TradingEventMap['position:closed']): void => {
      trades.push(data.trade);
    };
    bus.on('position:closed', tradeHandler);

    // Track global open positions
    const positionHandler = (): void => {
      this.globalOpenPositions++;
    };
    const positionClosedHandler = (): void => {
      this.globalOpenPositions = Math.max(0, this.globalOpenPositions - 1);
    };
    bus.on('position:opened', positionHandler);
    bus.on('position:closed', positionClosedHandler);

    // Wire up event forwarding from source bus to this instance bus
    const forwarders = this.setupForwarding(bus);

    // Create strategy via factory
    const strategy = this.config.factory(params, { bus, exchange: simExchange, executor });

    const instance: ArenaInstance = {
      params,
      bus,
      simExchange,
      executor,
      strategy,
      trades,
      tradeHandler,
      positionHandler,
      positionClosedHandler,
      forwarders,
    };

    this.instances.set(key, instance);

    // Start strategy (fire-and-forget since createInstance is sync)
    void strategy.start();
  }

  private wrapExecutorWithBudget(executor: IOrderExecutor, bus: IEventBus): IOrderExecutor {
    const maxGlobal = this.config.maxGlobalPositions!;
    return {
      submit: (request: OrderRequest): SubmissionReceipt => {
        if (this.globalOpenPositions >= maxGlobal && !request.reduceOnly) {
          const clientOrderId = request.clientOrderId ?? '';
          bus.emit('order:submitted', {
            receipt: {
              clientOrderId,
              symbol: request.symbol,
              side: request.side,
              type: request.type,
              quantity: request.quantity,
              submittedAt: Date.now(),
            },
          });
          bus.emit('order:rejected', {
            clientOrderId,
            reason: `Global position limit reached (${maxGlobal})`,
          });
          return {
            clientOrderId,
            symbol: request.symbol,
            side: request.side,
            type: request.type,
            quantity: request.quantity,
            submittedAt: Date.now(),
          };
        }
        return executor.submit(request);
      },
      cancelAll: (symbol: string): void => executor.cancelAll(symbol),
      hasPending: (symbol: string): boolean => executor.hasPending(symbol),
      getPendingCount: (): number => executor.getPendingCount(),
      start: (): Promise<void> => executor.start(),
      stop: (): Promise<void> => executor.stop(),
    };
  }

  private setupForwarding(targetBus: IEventBus): Array<() => void> {
    if (this.sourceBus === null) return [];

    const disposers: Array<() => void> = [];
    const sourceBus = this.sourceBus;

    for (const event of FORWARDED_EVENTS) {
      const handler = this.makeForwardHandler(event, targetBus);
      sourceBus.on(event, handler);
      const capturedEvent: ForwardedEvent = event;
      disposers.push(() => {
        sourceBus.off(capturedEvent, handler);
      });
    }

    return disposers;
  }

  // Each overload returns the correctly typed handler for that event
  private makeForwardHandler<K extends ForwardedEvent>(
    event: K,
    targetBus: IEventBus,
  ): (data: TradingEventMap[K]) => void {
    return (data: TradingEventMap[K]) => {
      targetBus.emit(event, data);
    };
  }

  private async destroyInstance(instance: ArenaInstance): Promise<void> {
    // Remove forwarding and event handlers (synchronous — always succeeds)
    for (const dispose of instance.forwarders) {
      dispose();
    }
    instance.bus.off('position:closed', instance.tradeHandler);
    instance.bus.off('position:opened', instance.positionHandler);
    instance.bus.off('position:closed', instance.positionClosedHandler);
    instance.simExchange.dispose();

    // Stop strategy with timeout — event flow is already severed so a hang is safe
    try {
      await Promise.race([
        instance.strategy.stop(),
        new Promise<void>((r) => setTimeout(r, 5000)),
      ]);
    } catch {
      // Strategy stop failed — event flow already cleaned up above
    }
  }
}
