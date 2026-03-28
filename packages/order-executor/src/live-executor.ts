import type { IEventBus } from '@trading-bot/event-bus';
import type { IExchange } from '@trading-bot/exchange-client';
import type { OrderRequest, SubmissionReceipt } from '@trading-bot/types';

import type { IOrderExecutor, OrderExecutorConfig } from './types';

/**
 * LiveExecutor — async order queue for live trading.
 *
 * Design (from Phase 3 grilling):
 * - submit() is sync (ADR-2 compliant): enqueues, emits order:submitted, returns receipt
 * - Queue processor: token bucket rate limiting, priority cancel queue
 * - Adapter emits order:filled on bus; executor subscribes to track pending set
 * - No retry in Phase 3a-minimal (transport failures reject immediately)
 * - placeOrder() resolves with ack (status NEW or REJECTED), not fill
 */

interface QueueItem {
  request: OrderRequest;
  receipt: SubmissionReceipt;
}

export class LiveExecutor implements IOrderExecutor {
  private readonly bus: IEventBus;
  private readonly exchange: IExchange;
  private readonly config: OrderExecutorConfig;

  private counter = 0;
  private readonly queue: QueueItem[] = [];
  private processing = false;
  private running = false;
  private processingPromise: Promise<void> = Promise.resolve();

  // Pending order tracking: clientOrderId → symbol
  private readonly pending = new Map<string, string>();

  // Token bucket rate limiter
  private tokens: number;
  private lastRefillTime: number = Date.now();
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond

  // Bus event handlers (stored for cleanup)
  private readonly handleFilled: (data: { order: { clientOrderId: string } }) => void;
  private readonly handleRejected: (data: { clientOrderId: string }) => void;
  private readonly handleCanceled: (data: { order: { clientOrderId: string } }) => void;

  constructor(bus: IEventBus, exchange: IExchange, config: OrderExecutorConfig) {
    if (config.rateLimitPerMinute <= 0) {
      throw new Error(
        `LiveExecutor: rateLimitPerMinute must be > 0, got ${config.rateLimitPerMinute}`,
      );
    }

    this.bus = bus;
    this.exchange = exchange;
    this.config = config;

    // Token bucket: 5% of rate limit as burst capacity, refill at full rate
    this.maxTokens = Math.max(1, Math.floor(config.rateLimitPerMinute * 0.05));
    this.tokens = this.maxTokens;
    this.refillRate = config.rateLimitPerMinute / 60_000;

    // Subscribe to fills/rejections to track pending set (ADR-8 reactive pattern)
    this.handleFilled = (data) => {
      this.pending.delete(data.order.clientOrderId);
    };
    this.handleRejected = (data) => {
      this.pending.delete(data.clientOrderId);
    };
    this.handleCanceled = (data) => {
      this.pending.delete(data.order.clientOrderId);
    };

    bus.on('order:filled', this.handleFilled);
    bus.on('order:rejected', this.handleRejected);
    bus.on('order:canceled', this.handleCanceled);
  }

  submit(request: OrderRequest): SubmissionReceipt {
    this.counter += 1;
    const clientOrderId = request.clientOrderId ?? `live-${this.counter}`;

    const receipt: SubmissionReceipt = {
      clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      submittedAt: Date.now(),
    };

    const requestWithId: OrderRequest = { ...request, clientOrderId };

    // Track as pending BEFORE emit (state-before-emit rule, ADR-2)
    this.pending.set(clientOrderId, requestWithId.symbol);

    const item: QueueItem = { request: requestWithId, receipt };
    this.queue.push(item);

    this.bus.emit('order:submitted', { receipt });

    if (this.running && !this.processing) {
      this.processingPromise = this.drainQueue();
    }

    return receipt;
  }

  cancelAll(symbol: string): void {
    // Remove unprocessed queue items for this symbol
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.request.symbol === symbol) {
        const removed = this.queue.splice(i, 1)[0]!;
        this.pending.delete(removed.receipt.clientOrderId);
      }
    }
  }

  hasPending(symbol: string): boolean {
    for (const [, sym] of this.pending) {
      if (sym === symbol) return true;
    }
    return false;
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  async start(): Promise<void> {
    this.running = true;
    if (this.queue.length > 0 && !this.processing) {
      this.processingPromise = this.drainQueue();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.processingPromise;

    // Unsubscribe from bus events
    this.bus.off('order:filled', this.handleFilled);
    this.bus.off('order:rejected', this.handleRejected);
    this.bus.off('order:canceled', this.handleCanceled);
  }

  // === Internal: Queue processing ===

  private async drainQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0 && this.running) {
      await this.consumeToken();
      const item = this.queue.shift();
      if (item === undefined) break;
      await this.processItem(item);
    }
    this.processing = false;
  }

  private async processItem(item: QueueItem, attempt = 0): Promise<void> {
    const { request } = item;

    try {
      const ack = await this.exchange.placeOrder(request);

      if (ack.status === 'REJECTED') {
        // Exchange rejected the order — definitive, never retry
        this.bus.emit('order:rejected', {
          clientOrderId: request.clientOrderId ?? '',
          reason: 'Order rejected by exchange',
        });
        this.pending.delete(request.clientOrderId ?? '');
      }
      // If status is NEW or FILLED: do nothing here.
      // Fills arrive via user data stream → adapter emits order:filled → pending set updated.
    } catch (err) {
      // Transport error — retry with exponential backoff + rate limit
      if (attempt < this.config.maxRetries) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (this.running) {
          await this.consumeToken();
          await this.processItem(item, attempt + 1);
        }
        return;
      }

      // Max retries exhausted — emit rejection
      const reason = err instanceof Error ? err.message : 'Unknown transport error';
      this.bus.emit('order:rejected', {
        clientOrderId: request.clientOrderId ?? '',
        reason: `Transport error after ${attempt + 1} attempts: ${reason}`,
      });
      this.pending.delete(request.clientOrderId ?? '');
    }
  }

  // === Internal: Token bucket rate limiter ===

  private async consumeToken(): Promise<void> {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait until we have a token
    const waitMs = (1 - this.tokens) / this.refillRate;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
    this.refillTokens();
    this.tokens -= 1;
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefillTime = now;
  }
}
