import { EventBus } from '@trading-bot/event-bus';
import type { IEventBus } from '@trading-bot/event-bus';
import { createExchange, type IExchange } from '@trading-bot/exchange-client';
import { LiveDataFeed, type IDataFeed } from '@trading-bot/data-feed';
import { LiveExecutor } from '@trading-bot/order-executor';
import type { IOrderExecutor } from '@trading-bot/order-executor';
import type { IStrategy, StrategyFactory } from '@trading-bot/strategy';
import type { ExchangeConfig, Timeframe } from '@trading-bot/types';

export type RunnerStatus = 'idle' | 'running' | 'stopping' | 'stopped';

export interface LiveRunnerConfig {
  factory: StrategyFactory;
  params: Record<string, number>;
  exchangeConfig: ExchangeConfig;
  symbols: string[];
  timeframes: Timeframe[];
  shutdownBehavior: 'close-all' | 'leave-open';
  healthCheckIntervalMs: number;
}

const DEFAULT_CONFIG: Pick<LiveRunnerConfig, 'shutdownBehavior' | 'healthCheckIntervalMs'> = {
  shutdownBehavior: 'leave-open',
  healthCheckIntervalMs: 30_000,
};

export interface ILiveRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly status: RunnerStatus;
  readonly strategy: IStrategy;
  readonly uptime: number;
}

export class LiveRunner implements ILiveRunner {
  private readonly config: LiveRunnerConfig;
  private _status: RunnerStatus = 'idle';
  private startTime = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastCandleTimestamp = 0;

  private bus!: IEventBus;
  private exchange!: IExchange;
  private dataFeed!: IDataFeed;
  private executor!: IOrderExecutor;
  private _strategy!: IStrategy;

  constructor(config: Partial<LiveRunnerConfig> & Pick<LiveRunnerConfig, 'factory' | 'params' | 'exchangeConfig' | 'symbols' | 'timeframes'>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get status(): RunnerStatus {
    return this._status;
  }

  get strategy(): IStrategy {
    return this._strategy;
  }

  get uptime(): number {
    if (this.startTime === 0) return 0;
    return Date.now() - this.startTime;
  }

  async start(): Promise<void> {
    if (this._status !== 'idle') {
      throw new Error(`Cannot start runner in ${this._status} state`);
    }

    // 1. Create environment (ADR-10: runner owns bus, exchange, executor)
    this.bus = new EventBus();
    this.exchange = createExchange(this.config.exchangeConfig);
    this.executor = new LiveExecutor(this.bus, this.exchange, {
      maxRetries: 0, // no retry in 3a-minimal
      retryDelayMs: 0,
      rateLimitPerMinute: 1200,
    });
    this.dataFeed = new LiveDataFeed(this.bus, this.exchange);

    // 2. Set up logging
    this.setupLogging();

    // 3. Connect to exchange
    await this.exchange.connect();

    // 4. Create strategy via factory
    this._strategy = this.config.factory(this.config.params, {
      bus: this.bus,
      exchange: this.exchange,
      executor: this.executor,
    });

    // 5. Start executor queue
    await this.executor.start();

    // 6. Start strategy
    await this._strategy.start();

    // 7. Start data feed (subscribe to streams, returns when ready)
    await this.dataFeed.start(this.config.symbols, this.config.timeframes);

    // 8. Start heartbeat
    this.startTime = Date.now();
    this._status = 'running';
    this.startHeartbeat();

    this.log('info', 'runner:started', {
      symbols: this.config.symbols,
      timeframes: this.config.timeframes,
      strategy: this._strategy.name,
      params: this.config.params,
    });
  }

  async stop(): Promise<void> {
    if (this._status !== 'running') return;
    this._status = 'stopping';

    this.log('info', 'runner:stopping', { uptime: this.uptime });

    // Stop heartbeat
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // 1. Stop data-feed (no new candle/tick events)
    await this.dataFeed.stop();

    // 2. Stop strategy (disposes scanners — no new signals)
    await this._strategy.stop();

    // 3. Drain executor queue (leave-open mode for 3a-minimal)
    await this.executor.stop();

    // 4. Disconnect exchange
    await this.exchange.disconnect();

    this._status = 'stopped';
    this.log('info', 'runner:stopped', { uptime: this.uptime });
  }

  // === Internal: Logging ===

  private setupLogging(): void {
    const eventsToLog = [
      'order:submitted',
      'order:filled',
      'order:rejected',
      'order:canceled',
      'signal',
      'position:opened',
      'position:closed',
      'risk:breach',
      'exchange:connected',
      'exchange:disconnected',
      'exchange:reconnecting',
      'exchange:gap',
      'error',
    ] as const;

    for (const event of eventsToLog) {
      this.bus.on(event, (data: unknown) => {
        this.log('info', event, data);
      });
    }

    // Track last candle time for staleness detection
    this.bus.on('candle:close', ({ candle }) => {
      this.lastCandleTimestamp = candle.closeTime;
    });
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.log('info', 'heartbeat', {
        uptime: this.uptime,
        wsConnected: this.exchange.isConnected(),
        pendingOrders: this.executor.getPendingCount(),
        lastCandleAge: this.lastCandleTimestamp > 0
          ? Date.now() - this.lastCandleTimestamp
          : -1,
      });
    }, this.config.healthCheckIntervalMs);
  }

  private log(level: string, event: string, data?: unknown): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(data !== null && typeof data === 'object' ? data : { data }),
    };
    // Structured JSON logging to stdout
    console.log(JSON.stringify(entry));
  }
}
