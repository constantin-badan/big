import type { OrderRequest, SubmissionReceipt } from '@trading-bot/types';

export interface OrderExecutorConfig {
  maxRetries: number;
  retryDelayMs: number;
  rateLimitPerMinute: number;
}

export interface IOrderExecutor {
  submit(request: OrderRequest): SubmissionReceipt;
  cancelAll(symbol: string): void;
  hasPending(symbol: string): boolean;
  getPendingCount(): number;
  start(): Promise<void>;
  stop(): Promise<void>;
}
