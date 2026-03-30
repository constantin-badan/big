import type { IEventBus, TradingEventMap } from '@trading-bot/types';

export interface MetricsConfig {
  port: number; // HTTP port for /metrics
}

export class MetricsCollector {
  // Counters
  private tradesTotal = 0;
  private tradesLong = 0;
  private tradesShort = 0;
  private tradesByExitReason = new Map<string, number>();
  private ordersSubmitted = 0;
  private ordersFilled = 0;
  private ordersRejected = 0;
  private ordersCanceled = 0;
  private reconnectAttempts = 0;
  private riskBreaches = 0;
  private errors = 0;

  // Gauges
  private openPositions = 0;
  private totalPnl = 0;
  private wsConnected = new Map<string, boolean>();

  // Cleanup: IEventBus uses on/off (not unsubscribe), so we store teardown fns
  private readonly teardowns: Array<() => void> = [];
  private server: ReturnType<typeof Bun.serve> | null = null;

  private readonly bus: IEventBus;
  private readonly config: MetricsConfig;

  constructor(bus: IEventBus, config: MetricsConfig) {
    this.bus = bus;
    this.config = config;
  }

  start(): void {
    // Subscribe to events
    this.subscribe('order:submitted', () => {
      this.ordersSubmitted++;
    });
    this.subscribe('order:filled', () => {
      this.ordersFilled++;
    });
    this.subscribe('order:rejected', () => {
      this.ordersRejected++;
    });
    this.subscribe('order:canceled', () => {
      this.ordersCanceled++;
    });

    this.subscribe('position:opened', () => {
      this.openPositions++;
    });
    this.subscribe('position:closed', (data) => {
      this.openPositions = Math.max(0, this.openPositions - 1);
      this.tradesTotal++;
      this.totalPnl += data.trade.pnl;

      // Track by side
      if (data.trade.side === 'LONG') this.tradesLong++;
      else this.tradesShort++;

      // Track by exit reason
      const reason = data.trade.exitReason;
      this.tradesByExitReason.set(
        reason,
        (this.tradesByExitReason.get(reason) ?? 0) + 1,
      );
    });

    this.subscribe('risk:breach', () => {
      this.riskBreaches++;
    });
    this.subscribe('error', () => {
      this.errors++;
    });

    this.subscribe('exchange:connected', (data) => {
      this.wsConnected.set(`${data.stream}:${data.symbol}`, true);
    });
    this.subscribe('exchange:disconnected', (data) => {
      this.wsConnected.set(`${data.stream}:${data.symbol}`, false);
    });
    this.subscribe('exchange:reconnecting', () => {
      this.reconnectAttempts++;
    });

    // Start HTTP server
    this.server = Bun.serve({
      port: this.config.port,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/metrics') {
          return new Response(this.serialize(), {
            headers: {
              'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
            },
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    });
  }

  stop(): void {
    for (const teardown of this.teardowns) {
      teardown();
    }
    this.teardowns.length = 0;
    if (this.server) {
      void this.server.stop();
      this.server = null;
    }
  }

  /** Type-safe subscribe that stores handler ref for later off(). */
  private subscribe<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void {
    this.bus.on(event, handler);
    this.teardowns.push(() => this.bus.off(event, handler));
  }

  private serialize(): string {
    const lines: string[] = [];

    const counter = (
      name: string,
      help: string,
      value: number,
      labels = '',
    ): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}${labels} ${String(value)}`);
    };

    const gauge = (
      name: string,
      help: string,
      value: number,
      labels = '',
    ): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${String(value)}`);
    };

    counter(
      'trading_orders_submitted_total',
      'Total orders submitted',
      this.ordersSubmitted,
    );
    counter(
      'trading_orders_filled_total',
      'Total orders filled',
      this.ordersFilled,
    );
    counter(
      'trading_orders_rejected_total',
      'Total orders rejected',
      this.ordersRejected,
    );
    counter(
      'trading_orders_canceled_total',
      'Total orders canceled',
      this.ordersCanceled,
    );

    counter(
      'trading_trades_total',
      'Total trades completed',
      this.tradesTotal,
    );
    counter('trading_trades_long_total', 'Total long trades', this.tradesLong);
    counter(
      'trading_trades_short_total',
      'Total short trades',
      this.tradesShort,
    );

    // Per exit reason
    lines.push(
      '# HELP trading_trades_by_exit_reason_total Trades by exit reason',
    );
    lines.push('# TYPE trading_trades_by_exit_reason_total counter');
    for (const [reason, count] of this.tradesByExitReason) {
      lines.push(
        `trading_trades_by_exit_reason_total{reason="${reason}"} ${String(count)}`,
      );
    }

    gauge(
      'trading_open_positions',
      'Current open positions',
      this.openPositions,
    );
    gauge('trading_pnl_total', 'Total realized PnL', this.totalPnl);

    counter(
      'trading_risk_breaches_total',
      'Total risk breaches',
      this.riskBreaches,
    );
    counter('trading_errors_total', 'Total errors', this.errors);
    counter(
      'trading_reconnect_attempts_total',
      'WebSocket reconnect attempts',
      this.reconnectAttempts,
    );

    // WS connection gauges
    lines.push('# HELP trading_ws_connected WebSocket connection status');
    lines.push('# TYPE trading_ws_connected gauge');
    for (const [key, connected] of this.wsConnected) {
      lines.push(
        `trading_ws_connected{stream="${key}"} ${connected ? '1' : '0'}`,
      );
    }

    lines.push('');
    return lines.join('\n');
  }
}
