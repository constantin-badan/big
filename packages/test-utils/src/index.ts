export { EventCapture } from './event-capture';
export { MockEventBus } from './mock-event-bus';
export { createMockExchange } from './mock-exchange';
export type { MockExchangeConfig } from './mock-exchange';
export { createMockExecutor } from './mock-executor';
export type { MockExecutorConfig } from './mock-executor';
export { fixtures } from './fixtures';

import { EventCapture } from './event-capture';
import { MockEventBus } from './mock-event-bus';

export function createTestBus() {
  const bus = new MockEventBus();
  const capture = new EventCapture(bus);
  return { bus, capture };
}
