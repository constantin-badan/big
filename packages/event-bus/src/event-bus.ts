import type { IEventBus, TradingEventMap } from './types';

export class EventBus implements IEventBus {
  private handlers = new Map<string, Set<(data: unknown) => void>>();

  on<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (data: unknown) => void);
  }

  off<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void {
    this.handlers.get(event)?.delete(handler as (data: unknown) => void);
  }

  emit<K extends keyof TradingEventMap>(
    event: K,
    data: TradingEventMap[K],
  ): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (err) {
        const name = handler.name || '<anonymous>';
        console.error(`EventBus: error in "${String(event)}" handler [${name}]:`, err);
      }
    }
  }

  once<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void {
    const wrapper = (data: unknown) => {
      this.off(event, wrapper as (data: TradingEventMap[K]) => void);
      handler(data as TradingEventMap[K]);
    };
    this.on(event, wrapper as (data: TradingEventMap[K]) => void);
  }

  removeAllListeners(event?: keyof TradingEventMap): void {
    if (event !== undefined) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  listenerCount(event: keyof TradingEventMap): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
