import type { IEventBus } from '@trading-bot/event-bus';
import type { IExchange } from '@trading-bot/exchange-client';
import type { OrderRequest, SubmissionReceipt } from '@trading-bot/types';
import type { IOrderExecutor, OrderExecutorConfig } from './types';

interface QueueItem {
  request: OrderRequest;
  receipt: SubmissionReceipt;
}

export class LiveExecutor implements IOrderExecutor {
  private readonly bus: IEventBus;
  private readonly exchange: IExchange;
  private readonly config: OrderExecutorConfig;

  private counter = 0;
  private queue: QueueItem[] = [];
  private processing = false;
  private running = false;
  private processingPromise: Promise<void> = Promise.resolve();

  // Sliding window rate limiter: timestamps of recent submissions
  private requestTimestamps: number[] = [];

  constructor(bus: IEventBus, exchange: IExchange, config: OrderExecutorConfig) {
    this.bus = bus;
    this.exchange = exchange;
    this.config = config;
  }

  submit(request: OrderRequest): SubmissionReceipt {
    this.counter += 1;
    const clientOrderId = request.clientOrderId ?? `live-order-${this.counter}`;

    // Build receipt BEFORE any emit (state-before-emit rule, ADR-2)
    const receipt: SubmissionReceipt = {
      clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      submittedAt: Date.now(),
    };

    const requestWithId: OrderRequest = { ...request, clientOrderId };

    // Enqueue BEFORE emit so state is consistent if re-entry occurs
    this.queue.push({ request: requestWithId, receipt });

    this.bus.emit('order:submitted', { receipt });

    if (this.running && !this.processing) {
      this.processingPromise = this.drainQueue();
    }

    return receipt;
  }

  cancelAll(symbol: string): void {
    // Remove pending items for this symbol from the queue
    this.queue = this.queue.filter((item) => item.request.symbol !== symbol);
    // Note: in-flight orders cannot be canceled synchronously here;
    // a full implementation would track them and call exchange.cancelOrder.
  }

  hasPending(symbol: string): boolean {
    return this.queue.some((item) => item.request.symbol === symbol);
  }

  getPendingCount(): number {
    return this.queue.length;
  }

  start(): Promise<void> {
    this.running = true;
    if (this.queue.length > 0 && !this.processing) {
      this.processingPromise = this.drainQueue();
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    return this.processingPromise;
  }

  private async drainQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0 && this.running) {
      await this.waitForRateLimit();
      const item = this.queue.shift();
      if (item === undefined) break;
      await this.processItem(item);
    }
    this.processing = false;
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = 60_000;
    const limit = this.config.rateLimitPerMinute;

    // Prune timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < windowMs);

    if (this.requestTimestamps.length >= limit) {
      // Wait until the oldest timestamp falls out of the window
      const oldest = this.requestTimestamps[0];
      if (oldest !== undefined) {
        const waitMs = windowMs - (now - oldest) + 1;
        if (waitMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
      }
      // Re-prune after waiting
      const nowAfterWait = Date.now();
      this.requestTimestamps = this.requestTimestamps.filter(
        (t) => nowAfterWait - t < windowMs,
      );
    }

    this.requestTimestamps.push(Date.now());
  }

  private async processItem(item: QueueItem): Promise<void> {
    const { request } = item;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.config.retryDelayMs));
      }

      try {
        const result = await this.exchange.placeOrder(request);
        this.bus.emit('order:filled', { order: result });
        return;
      } catch (err) {
        lastError = err;
      }
    }

    const reason =
      lastError instanceof Error ? lastError.message : 'Unknown error after retries';

    this.bus.emit('order:rejected', {
      clientOrderId: request.clientOrderId ?? '',
      reason,
    });
  }
}
