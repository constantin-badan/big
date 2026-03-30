import type { IEventBus, TradingEventMap } from '@trading-bot/types';
import type { AlertChannel } from './channels';

export interface AlertConfig {
  channels: AlertChannel[];
  disconnectAlertDelayMs?: number; // default 300_000 (5 min)
  maxAlertsPerMinute?: number; // default 10
}

export class AlertManager {
  private readonly bus: IEventBus;
  private readonly channels: AlertChannel[];
  private readonly disconnectDelay: number;
  private readonly maxPerMinute: number;
  private readonly handlers: Array<() => void> = [];
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private alertTimestamps: number[] = [];

  constructor(bus: IEventBus, config: AlertConfig) {
    this.bus = bus;
    this.channels = config.channels;
    this.disconnectDelay = config.disconnectAlertDelayMs ?? 300_000;
    this.maxPerMinute = config.maxAlertsPerMinute ?? 10;
  }

  start(): void {
    this.subscribe('risk:breach', (data) => {
      if (data.severity === 'KILL') {
        void this.alert(`KILL SWITCH -- ${data.rule}: ${data.message}`);
      }
    });

    this.subscribe('exchange:disconnected', (data) => {
      const key = `${data.stream}:${data.symbol}`;
      const timer = setTimeout(() => {
        void this.alert(
          `DISCONNECTED -- ${data.stream} (${data.symbol}) down for ${String(this.disconnectDelay / 60_000)}min`,
        );
        this.disconnectTimers.delete(key);
      }, this.disconnectDelay);
      this.disconnectTimers.set(key, timer);
    });

    this.subscribe('exchange:connected', (data) => {
      const key = `${data.stream}:${data.symbol}`;
      const timer = this.disconnectTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.disconnectTimers.delete(key);
      }
    });

    this.subscribe('position:closed', (data) => {
      if (data.trade.pnl < 0 && Math.abs(data.trade.pnl) > 100) {
        void this.alert(`LARGE LOSS -- ${data.trade.symbol}: $${data.trade.pnl.toFixed(2)}`);
      }
    });

    this.subscribe('error', (data) => {
      void this.alert(`ERROR -- ${data.source}: ${data.error.message}`);
    });
  }

  stop(): void {
    for (const unsub of this.handlers) unsub();
    this.handlers.length = 0;
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
  }

  private subscribe<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void {
    this.bus.on(event, handler);
    this.handlers.push(() => this.bus.off(event, handler));
  }

  private async alert(message: string): Promise<void> {
    const now = Date.now();
    this.alertTimestamps = this.alertTimestamps.filter((t) => now - t < 60_000);
    if (this.alertTimestamps.length >= this.maxPerMinute) return;
    this.alertTimestamps.push(now);

    await Promise.allSettled(this.channels.map((ch) => ch.send(message)));
  }
}
