import type { IEventBus, TradingEventMap } from '@trading-bot/event-bus';

export class EventCapture {
  private events = new Map<string, unknown[]>();
  private disposers: (() => void)[] = [];

  constructor(bus: IEventBus) {
    const eventNames: (keyof TradingEventMap)[] = [
      'candle:close',
      'candle:update',
      'tick',
      'scanner:signal',
      'signal',
      'order:submitted',
      'order:filled',
      'order:rejected',
      'order:canceled',
      'position:opened',
      'position:updated',
      'position:closed',
      'risk:breach',
      'exchange:connected',
      'exchange:disconnected',
      'exchange:reconnecting',
      'exchange:gap',
      'error',
    ];

    for (const name of eventNames) {
      const handler = (data: TradingEventMap[typeof name]) => {
        let list = this.events.get(name);
        if (!list) {
          list = [];
          this.events.set(name, list);
        }
        list.push(data);
      };
      bus.on(name, handler);
      this.disposers.push(() => bus.off(name, handler));
    }
  }

  get<K extends keyof TradingEventMap>(event: K): TradingEventMap[K][] {
    return (this.events.get(event) ?? []) as TradingEventMap[K][];
  }

  count<K extends keyof TradingEventMap>(event: K): number {
    return this.events.get(event)?.length ?? 0;
  }

  last<K extends keyof TradingEventMap>(event: K): TradingEventMap[K] | undefined {
    const list = this.events.get(event);
    return list?.[list.length - 1] as TradingEventMap[K] | undefined;
  }

  clear(): void {
    this.events.clear();
  }

  dispose(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
  }
}
