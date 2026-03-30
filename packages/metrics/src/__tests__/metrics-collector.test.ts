import { describe, test, expect, afterEach } from 'bun:test';
import { MetricsCollector } from '../metrics-collector';
import { EventBus } from '@trading-bot/event-bus';
import { unsafeCast } from '../unsafe-cast';
import type { TradingEventMap } from '@trading-bot/types';

describe('MetricsCollector', () => {
  let collector: MetricsCollector | null = null;

  afterEach(() => {
    if (collector) {
      collector.stop();
      collector = null;
    }
  });

  test('serves /metrics endpoint with Prometheus format', async () => {
    const bus = new EventBus();
    collector = new MetricsCollector(bus, { port: 0 });
    collector.start();

    // The port may be auto-assigned — try fetching
    // Since port 0 may not work with Bun.serve, use a high port
    collector.stop();

    collector = new MetricsCollector(bus, { port: 19123 });
    collector.start();

    const res = await fetch('http://localhost:19123/metrics');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('trading_orders_submitted_total');
    expect(body).toContain('trading_trades_total');
    expect(body).toContain('# TYPE');
  });

  test('increments counters on events', async () => {
    const bus = new EventBus();
    collector = new MetricsCollector(bus, { port: 19124 });
    collector.start();

    bus.emit('order:submitted', unsafeCast<TradingEventMap['order:submitted']>({
      receipt: {
        clientOrderId: 'test',
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: 0.1,
        submittedAt: Date.now(),
      },
    }));
    bus.emit('order:filled', unsafeCast<TradingEventMap['order:filled']>({
      order: {
        orderId: '1',
        clientOrderId: 'test',
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        status: 'FILLED',
        price: 50000,
        avgPrice: 50000,
        filledQuantity: 0.1,
        commission: 5,
        timestamp: Date.now(),
      },
    }));

    const res = await fetch('http://localhost:19124/metrics');
    const body = await res.text();
    expect(body).toContain('trading_orders_submitted_total 1');
    expect(body).toContain('trading_orders_filled_total 1');
  });
});
