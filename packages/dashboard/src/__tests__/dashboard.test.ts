import { describe, test, expect } from 'bun:test';
import { Dashboard } from '../dashboard';
import { EventBus } from '@trading-bot/event-bus';

describe('Dashboard', () => {
  test('can be created and stopped without errors', () => {
    const bus = new EventBus();
    const dashboard = new Dashboard(bus);
    // Don't start (it writes to stdout), just verify construction
    expect(dashboard).toBeDefined();
  });

  test('start and stop lifecycle', () => {
    const bus = new EventBus();
    const dashboard = new Dashboard(bus);
    // Redirect stdout to suppress rendering
    const origWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
      dashboard.start();
      dashboard.stop();
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
