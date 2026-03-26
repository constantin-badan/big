import type { IEventBus, TradingEventMap } from './types';

function isSet<T>(value: unknown): value is Set<T> {
  return value instanceof Set;
}

export class EventBus implements IEventBus {
  private store = new Map<string, unknown>();

  private getHandlers<K extends keyof TradingEventMap>(
    event: K,
  ): Set<(data: TradingEventMap[K]) => void> | undefined {
    const raw = this.store.get(event);
    if (isSet<(data: TradingEventMap[K]) => void>(raw)) return raw;
    return undefined;
  }

  private ensureHandlers<K extends keyof TradingEventMap>(
    event: K,
  ): Set<(data: TradingEventMap[K]) => void> {
    const existing = this.getHandlers(event);
    if (existing) return existing;
    const fresh = new Set<(data: TradingEventMap[K]) => void>();
    this.store.set(event, fresh);
    return fresh;
  }

  on<K extends keyof TradingEventMap>(event: K, handler: (data: TradingEventMap[K]) => void): void {
    this.ensureHandlers(event).add(handler);
  }

  off<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void {
    this.getHandlers(event)?.delete(handler);
  }

  emit<K extends keyof TradingEventMap>(event: K, data: TradingEventMap[K]): void {
    const set = this.getHandlers(event);
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
    const wrapper = (data: TradingEventMap[K]): void => {
      this.off(event, wrapper);
      handler(data);
    };
    this.on(event, wrapper);
  }

  removeAllListeners(event?: keyof TradingEventMap): void {
    if (event !== undefined) {
      this.store.delete(event);
    } else {
      this.store.clear();
    }
  }

  listenerCount(event: keyof TradingEventMap): number {
    return this.getHandlers(event)?.size ?? 0;
  }
}
