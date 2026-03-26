import type { IEventBus } from '@trading-bot/event-bus';
import type { OrderRequest, SubmissionReceipt } from '@trading-bot/types';
import type { IFillSimulator, IOrderExecutor } from './types';

export class BacktestExecutor implements IOrderExecutor {
  private readonly bus: IEventBus;
  private readonly fillSimulator: IFillSimulator;
  private counter = 0;

  constructor(bus: IEventBus, fillSimulator: IFillSimulator) {
    this.bus = bus;
    this.fillSimulator = fillSimulator;
  }

  submit(request: OrderRequest): SubmissionReceipt {
    this.counter += 1;
    const clientOrderId = request.clientOrderId ?? `backtest-order-${this.counter}`;

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

    this.bus.emit('order:submitted', { receipt });

    const result = this.fillSimulator.simulateFill(requestWithId);

    if (result.status === 'FILLED') {
      this.bus.emit('order:filled', { order: result });
    } else {
      this.bus.emit('order:rejected', {
        clientOrderId: result.clientOrderId,
        reason: `Order ${result.status}`,
      });
    }

    return receipt;
  }

  cancelAll(_symbol: string): void {
    // No-op: fills are instant in backtest, nothing is pending
  }

  hasPending(_symbol: string): boolean {
    return false;
  }

  getPendingCount(): number {
    return 0;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
