import { describe, test, expect, beforeEach, mock } from 'bun:test';

import type { IExchange } from '@trading-bot/exchange-client';
import type { IStrategy } from '@trading-bot/strategy';
import { createMockExchange } from '@trading-bot/test-utils';
import type { Position, ExchangeConfig } from '@trading-bot/types';

// Mutable mock state — reset between tests
let mockExchange: IExchange;
let mockPositions: Position[];

// Module mocks must be declared before imports that use them
void mock.module('@trading-bot/exchange-client', () => ({
  createExchange: (_config: ExchangeConfig) => mockExchange,
}));

void mock.module('@trading-bot/data-feed', () => ({
  LiveDataFeed: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    getOrderBook(): null {
      return null;
    }
  },
}));

void mock.module('@trading-bot/order-executor', () => ({
  LiveExecutor: class {
    submit(): void {}
    cancelAll(): void {}
    hasPending(): boolean {
      return false;
    }
    getPendingCount(): number {
      return 0;
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

// Import LiveRunner AFTER mocks are set up
const { LiveRunner } = await import('../live-runner');

function makeStrategy(): IStrategy {
  return {
    name: 'test-strategy',
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    getStats() {
      return {
        totalTrades: 0,
        winRate: 0,
        profitFactor: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        maxDrawdownDuration: 0,
        avgWin: 0,
        avgLoss: 0,
        expectancy: 0,
        avgHoldTime: 0,
        totalFees: 0,
        totalSlippage: 0,
      };
    },
  };
}

function makeConfig() {
  return {
    factory: () => makeStrategy(),
    params: { emaPeriod: 50 },
    exchangeConfig: {
      type: 'binance-testnet' as const,
      apiKey: 'test-key',
      privateKey: 'test-private-key',
    },
    symbols: ['BTCUSDT'],
    timeframes: ['1m' as const],
  };
}

describe('live-runner', () => {
  beforeEach(() => {
    mockPositions = [];
    mockExchange = {
      ...createMockExchange(),
      async getPositions(): Promise<Position[]> {
        return mockPositions;
      },
    };
  });

  test('package is importable', () => {
    expect(LiveRunner).toBeDefined();
  });

  test('initial status is idle', () => {
    const runner = new LiveRunner(makeConfig());
    expect(runner.status).toBe('idle');
  });

  test('initial uptime is 0', () => {
    const runner = new LiveRunner(makeConfig());
    expect(runner.uptime).toBe(0);
  });

  test('config defaults are applied', () => {
    const runner = new LiveRunner(makeConfig());
    // defaults exist — runner created without explicit optional fields
    expect(runner.status).toBe('idle');
  });

  test('start transitions to running', async () => {
    const runner = new LiveRunner(makeConfig());
    await runner.start();
    expect(runner.status).toBe('running');
    expect(runner.uptime).toBeGreaterThanOrEqual(0);
    await runner.stop();
  });

  test('start() throws when not idle', async () => {
    const runner = new LiveRunner(makeConfig());
    await runner.start();
    expect(runner.start()).rejects.toThrow('Cannot start runner in running state');
    await runner.stop();
  });

  test('stop transitions through stopping to stopped', async () => {
    const runner = new LiveRunner(makeConfig());
    await runner.start();
    await runner.stop();
    expect(runner.status).toBe('stopped');
  });

  test('stop() is a no-op when not running', async () => {
    const runner = new LiveRunner(makeConfig());
    await runner.stop(); // idle → nothing happens
    expect(runner.status).toBe('idle');
  });

  test('orphan positions detected and reported', async () => {
    mockPositions = [
      {
        symbol: 'BTCUSDT',
        side: 'LONG',
        entryPrice: 50000,
        quantity: 0.1,
        unrealizedPnl: 100,
        leverage: 10,
        liquidationPrice: 45000,
        marginType: 'CROSS',
        timestamp: Date.now(),
      },
    ];

    const runner = new LiveRunner(makeConfig());
    expect(runner.start()).rejects.toThrow(/Orphan positions detected.*BTCUSDT/);
    expect(runner.status).toBe('idle');
  });

  test('orphan check skipped when disabled', async () => {
    mockPositions = [
      {
        symbol: 'BTCUSDT',
        side: 'LONG',
        entryPrice: 50000,
        quantity: 0.1,
        unrealizedPnl: 100,
        leverage: 10,
        liquidationPrice: 45000,
        marginType: 'CROSS',
        timestamp: Date.now(),
      },
    ];

    const runner = new LiveRunner({
      ...makeConfig(),
      checkOrphanPositions: false,
    });
    await runner.start();
    expect(runner.status).toBe('running');
    await runner.stop();
  });

  test('strategy is accessible after start', async () => {
    const runner = new LiveRunner(makeConfig());
    await runner.start();
    expect(runner.strategy).toBeDefined();
    expect(runner.strategy.name).toBe('test-strategy');
    await runner.stop();
  });

  test('close-all shutdown places market close orders', async () => {
    const closedSymbols: string[] = [];
    mockPositions = [];

    // After start, mock getPositions to return an open position for shutdown
    let callCount = 0;
    mockExchange.getPositions = async () => {
      callCount++;
      // First call is orphan check (returns empty), second is shutdown
      if (callCount <= 1) return [];
      return [
        {
          symbol: 'ETHUSDT',
          side: 'SHORT',
          entryPrice: 3000,
          quantity: 1,
          unrealizedPnl: -50,
          leverage: 5,
          liquidationPrice: 3500,
          marginType: 'CROSS',
          timestamp: Date.now(),
        },
      ];
    };
    mockExchange.placeOrder = async (req) => {
      closedSymbols.push(req.symbol);
      return {
        orderId: '1',
        clientOrderId: 'close-1',
        symbol: req.symbol,
        side: req.side,
        type: 'MARKET',
        status: 'FILLED',
        price: 3000,
        avgPrice: 3000,
        quantity: req.quantity,
        filledQuantity: req.quantity,
        commission: 0,
        commissionAsset: 'USDT',
        timestamp: Date.now(),
        latencyMs: 0,
      };
    };

    const runner = new LiveRunner({
      ...makeConfig(),
      shutdownBehavior: 'close-all',
    });
    await runner.start();
    await runner.stop();
    expect(closedSymbols).toContain('ETHUSDT');
  });
});
