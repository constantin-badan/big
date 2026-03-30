import { describe, test, expect } from 'bun:test';
import { AlertManager, type AlertConfig } from '../alert-manager';
import type { AlertChannel } from '../channels';
import { EventBus } from '@trading-bot/event-bus';

function makeChannel(): AlertChannel & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    async send(msg: string) {
      messages.push(msg);
    },
  };
}

describe('AlertManager', () => {
  test('sends alert on risk:breach with KILL severity', async () => {
    const bus = new EventBus();
    const channel = makeChannel();
    const config: AlertConfig = { channels: [channel] };
    const mgr = new AlertManager(bus, config);
    mgr.start();

    bus.emit('risk:breach', {
      rule: 'MAX_DRAWDOWN',
      message: 'Drawdown exceeded 15%',
      severity: 'KILL',
    });

    // Allow async alert to flush
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(channel.messages.length).toBe(1);
    expect(channel.messages[0]).toContain('KILL');

    mgr.stop();
  });

  test('rate limits alerts', async () => {
    const bus = new EventBus();
    const channel = makeChannel();
    const config: AlertConfig = { channels: [channel], maxAlertsPerMinute: 2 };
    const mgr = new AlertManager(bus, config);
    mgr.start();

    for (let i = 0; i < 5; i++) {
      bus.emit('risk:breach', {
        rule: 'MAX_DRAWDOWN',
        message: `Breach ${String(i)}`,
        severity: 'KILL',
      });
    }

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(channel.messages.length).toBe(2);

    mgr.stop();
  });
});
