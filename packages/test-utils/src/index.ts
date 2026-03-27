export { EventCapture } from './event-capture';
export { createMockExchange } from './mock-exchange';
export type { MockExchangeConfig } from './mock-exchange';
export { createMockExecutor } from './mock-executor';
export type { MockExecutorConfig } from './mock-executor';
export { fixtures } from './fixtures';

import { EventBus } from '@trading-bot/event-bus';

import { EventCapture } from './event-capture';

export function createTestBus() {
  const bus = new EventBus();
  const capture = new EventCapture(bus);
  return { bus, capture };
}
