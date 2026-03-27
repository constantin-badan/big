import { BacktestSimExchange } from '@trading-bot/backtest-engine';
import { LiveDataFeed } from '@trading-bot/data-feed';
import { EventBus } from '@trading-bot/event-bus';
import type { IEventBus, TradingEventMap } from '@trading-bot/event-bus';
import { createExchange } from '@trading-bot/exchange-client';
import type { IExchange } from '@trading-bot/exchange-client';
import { BacktestExecutor } from '@trading-bot/order-executor';
import { computeMetrics } from '@trading-bot/reporting';
import type { IStrategy } from '@trading-bot/strategy';
import type { ExchangeConfig, TradeRecord } from '@trading-bot/types';

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
  executor: BacktestExecutor;
  strategy: IStrategy;
  trades: TradeRecord[];
  tradeHandler: (data: TradingEventMap['position:closed']) => void;
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

    // Fire-and-forget cleanup since interface is sync
    void this.destroyInstance(instance);
    this.instances.delete(key);
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
    const executor = new BacktestExecutor(bus, simExchange);

    // Collect trades from position:closed events
    const trades: TradeRecord[] = [];
    const tradeHandler = (data: TradingEventMap['position:closed']): void => {
      trades.push(data.trade);
    };
    bus.on('position:closed', tradeHandler);

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
      forwarders,
    };

    this.instances.set(key, instance);

    // Start strategy (fire-and-forget since createInstance is sync)
    void strategy.start();
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
    // Remove forwarding
    for (const dispose of instance.forwarders) {
      dispose();
    }

    // Stop strategy
    await instance.strategy.stop();

    // Remove trade handler
    instance.bus.off('position:closed', instance.tradeHandler);

    // Dispose sim exchange (unsubscribes from bus)
    instance.simExchange.dispose();
  }
}
