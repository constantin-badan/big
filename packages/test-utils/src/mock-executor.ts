import type { IEventBus } from '@trading-bot/event-bus';
import type { IOrderExecutor } from '@trading-bot/order-executor';
import type { OrderRequest, SubmissionReceipt } from '@trading-bot/types';

export interface MockExecutorConfig {
  syncFill?: boolean;
  fillPrice?: number;
  commission?: number;
  rejectAll?: boolean;
  rejectReason?: string;
}

export function createMockExecutor(bus: IEventBus, config?: MockExecutorConfig): IOrderExecutor {
  const syncFill = config?.syncFill ?? true;
  const fillPrice = config?.fillPrice;
  const commission = config?.commission ?? 0;
  const rejectAll = config?.rejectAll ?? false;
  const rejectReason = config?.rejectReason ?? 'Rejected by mock';
  const submitted: SubmissionReceipt[] = [];
  let idCounter = 0;

  return {
    submit(request: OrderRequest): SubmissionReceipt {
      idCounter++;
      const clientOrderId = request.clientOrderId ?? `mock-${String(idCounter)}`;
      const receipt: SubmissionReceipt = {
        clientOrderId,
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity: request.quantity,
        submittedAt: Date.now(),
      };
      submitted.push(receipt);

      bus.emit('order:submitted', { receipt });

      if (syncFill) {
        if (rejectAll) {
          bus.emit('order:rejected', { clientOrderId, reason: rejectReason });
        } else {
          bus.emit('order:filled', {
            order: {
              orderId: `fill-${String(idCounter)}`,
              clientOrderId,
              symbol: request.symbol,
              side: request.side,
              type: request.type,
              status: 'FILLED',
              price: request.price ?? fillPrice ?? 50000,
              avgPrice: fillPrice ?? request.price ?? 50000,
              quantity: request.quantity,
              filledQuantity: request.quantity,
              commission,
              commissionAsset: 'USDT',
              timestamp: Date.now(),
              latencyMs: 0,
            },
          });
        }
      }

      return receipt;
    },
    cancelAll(): void {},
    hasPending(): boolean {
      return false;
    },
    getPendingCount(): number {
      return 0;
    },
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
  };
}
