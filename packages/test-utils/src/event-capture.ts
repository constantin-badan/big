import type { IEventBus, TradingEventMap } from '@trading-bot/types';

function isArray<T>(value: unknown): value is T[] {
  return Array.isArray(value);
}

export class EventCapture {
  private store = new Map<string, unknown>();
  private disposers: (() => void)[] = [];

  constructor(bus: IEventBus) {
    this.subscribe(bus, 'candle:close');
    this.subscribe(bus, 'candle:update');
    this.subscribe(bus, 'tick');
    this.subscribe(bus, 'scanner:signal');
    this.subscribe(bus, 'signal');
    this.subscribe(bus, 'order:submitted');
    this.subscribe(bus, 'order:filled');
    this.subscribe(bus, 'order:rejected');
    this.subscribe(bus, 'order:canceled');
    this.subscribe(bus, 'position:opened');
    this.subscribe(bus, 'position:updated');
    this.subscribe(bus, 'position:closed');
    this.subscribe(bus, 'risk:breach');
    this.subscribe(bus, 'exchange:connected');
    this.subscribe(bus, 'exchange:disconnected');
    this.subscribe(bus, 'exchange:reconnecting');
    this.subscribe(bus, 'exchange:gap');
    this.subscribe(bus, 'error');
  }

  private getList<K extends keyof TradingEventMap>(event: K): TradingEventMap[K][] | undefined {
    const raw = this.store.get(event);
    if (isArray<TradingEventMap[K]>(raw)) return raw;
    return undefined;
  }

  private ensureList<K extends keyof TradingEventMap>(event: K): TradingEventMap[K][] {
    const existing = this.getList(event);
    if (existing) return existing;
    const fresh: TradingEventMap[K][] = [];
    this.store.set(event, fresh);
    return fresh;
  }

  private subscribe<K extends keyof TradingEventMap>(bus: IEventBus, event: K): void {
    const handler = (data: TradingEventMap[K]): void => {
      this.ensureList(event).push(data);
    };
    bus.on(event, handler);
    this.disposers.push(() => bus.off(event, handler));
  }

  get<K extends keyof TradingEventMap>(event: K): TradingEventMap[K][] {
    return this.getList(event) ?? [];
  }

  count<K extends keyof TradingEventMap>(event: K): number {
    return this.getList(event)?.length ?? 0;
  }

  last<K extends keyof TradingEventMap>(event: K): TradingEventMap[K] | undefined {
    const list = this.getList(event);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  clear(): void {
    this.store.clear();
  }

  dispose(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
  }
}
