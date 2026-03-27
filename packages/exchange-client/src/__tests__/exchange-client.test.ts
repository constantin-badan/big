import { describe, test, expect } from 'bun:test';

import type { ExchangeConfig } from '@trading-bot/types';

import { createExchange } from '../factory';
import { BinanceAdapter } from '../binance/adapter';
import {
  buildQueryString,
  parseCombinedStreamMessage,
  parseKlineMessage,
  parseAggTradeMessage,
  parseDepthMessage,
  parseOrderTradeUpdate,
  parseAlgoUpdate,
  buildOrderParams,
  routeOrderType,
  parseRestCandles,
} from '../binance';

describe('exchange-client', () => {
  test('module exports are importable', async () => {
    const mod = await import('../index');
    expect(mod.createExchange).toBeDefined();
    expect(mod.BinanceAdapter).toBeDefined();
  });

  test('createExchange returns BinanceAdapter for binance-live', () => {
    const config: ExchangeConfig = {
      type: 'binance-live',
      apiKey: 'key',
      privateKey: 'secret',
    };
    const exchange = createExchange(config);
    expect(exchange).toBeInstanceOf(BinanceAdapter);
  });

  test('createExchange returns BinanceAdapter for binance-testnet', () => {
    const config: ExchangeConfig = {
      type: 'binance-testnet',
      apiKey: 'key',
      privateKey: 'secret',
    };
    const exchange = createExchange(config);
    expect(exchange).toBeInstanceOf(BinanceAdapter);
  });

  test('createExchange throws for backtest-sim', () => {
    const config: ExchangeConfig = {
      type: 'backtest-sim',
      feeStructure: { maker: 0.0002, taker: 0.0004 },
      slippageModel: { type: 'fixed', fixedBps: 5 },
      initialBalance: 10000,
    };
    expect(() => createExchange(config)).toThrow('Not implemented: backtest-sim');
  });
});

// === Pure function unit tests ===

describe('buildQueryString', () => {
  test('sorts keys alphabetically and joins with &', () => {
    const result = buildQueryString({ zebra: 1, apple: 'hello', mango: 42 });
    expect(result).toBe('apple=hello&mango=42&zebra=1');
  });

  test('handles single param', () => {
    expect(buildQueryString({ key: 'value' })).toBe('key=value');
  });

  test('handles empty params', () => {
    expect(buildQueryString({})).toBe('');
  });
});

describe('parseCombinedStreamMessage', () => {
  test('parses valid combined stream message', () => {
    const raw = JSON.stringify({ stream: 'btcusdt@kline_1m', data: { test: true } });
    const result = parseCombinedStreamMessage(raw);
    expect(result.stream).toBe('btcusdt@kline_1m');
    expect(result.data).toEqual({ test: true });
  });

  test('throws on missing stream field', () => {
    const raw = JSON.stringify({ data: {} });
    expect(() => parseCombinedStreamMessage(raw)).toThrow('missing stream or data');
  });

  test('throws on missing data field', () => {
    const raw = JSON.stringify({ stream: 'test' });
    expect(() => parseCombinedStreamMessage(raw)).toThrow('missing stream or data');
  });
});

describe('parseKlineMessage', () => {
  test('parses Binance kline event into Candle', () => {
    const data = {
      e: 'kline',
      k: {
        t: 1700000000000,
        T: 1700000059999,
        o: '50000.00',
        h: '50100.00',
        l: '49900.00',
        c: '50050.00',
        v: '100.5',
        q: '5025000.00',
        n: 500,
        x: true,
      },
    };
    const candle = parseKlineMessage(data);
    expect(candle.openTime).toBe(1700000000000);
    expect(candle.closeTime).toBe(1700000059999);
    expect(candle.open).toBe(50000);
    expect(candle.high).toBe(50100);
    expect(candle.low).toBe(49900);
    expect(candle.close).toBe(50050);
    expect(candle.volume).toBe(100.5);
    expect(candle.quoteVolume).toBe(5025000);
    expect(candle.trades).toBe(500);
    expect(candle.isClosed).toBe(true);
  });

  test('isClosed is false for forming candle', () => {
    const data = {
      e: 'kline',
      k: {
        t: 0, T: 0, o: '1', h: '1', l: '1', c: '1',
        v: '1', q: '1', n: 0, x: false,
      },
    };
    expect(parseKlineMessage(data).isClosed).toBe(false);
  });
});

describe('parseAggTradeMessage', () => {
  test('parses Binance aggTrade event into Tick', () => {
    const data = {
      e: 'aggTrade',
      s: 'BTCUSDT',
      p: '50000.50',
      q: '0.123',
      T: 1700000000000,
      m: true,
    };
    const tick = parseAggTradeMessage(data);
    expect(tick.symbol).toBe('BTCUSDT');
    expect(tick.price).toBe(50000.5);
    expect(tick.quantity).toBe(0.123);
    expect(tick.timestamp).toBe(1700000000000);
    expect(tick.isBuyerMaker).toBe(true);
  });
});

describe('parseDepthMessage', () => {
  test('parses Binance depth event into OrderBookDiff', () => {
    const data = {
      e: 'depthUpdate',
      s: 'BTCUSDT',
      T: 1700000000000,
      b: [['50000.00', '1.5'], ['49999.00', '0']],
      a: [['50001.00', '2.0']],
      U: 100,
      u: 105,
    };
    const diff = parseDepthMessage(data);
    expect(diff.symbol).toBe('BTCUSDT');
    expect(diff.timestamp).toBe(1700000000000);
    expect(diff.bids).toEqual([[50000, 1.5], [49999, 0]]);
    expect(diff.asks).toEqual([[50001, 2.0]]);
    expect(diff.firstUpdateId).toBe(100);
    expect(diff.lastUpdateId).toBe(105);
  });
});

describe('parseOrderTradeUpdate', () => {
  test('parses ORDER_TRADE_UPDATE into OrderResult', () => {
    const data = {
      e: 'ORDER_TRADE_UPDATE',
      T: 1700000000000,
      o: {
        s: 'BTCUSDT',
        c: 'client-123',
        S: 'BUY',
        o: 'MARKET',
        q: '0.1',
        p: '0',
        ap: '50000.00',
        X: 'FILLED',
        i: 12345,
        z: '0.1',
        n: '0.005',
        N: 'USDT',
        T: 1700000000100,
      },
    };
    const result = parseOrderTradeUpdate(data);
    expect(result.orderId).toBe('12345');
    expect(result.clientOrderId).toBe('client-123');
    expect(result.symbol).toBe('BTCUSDT');
    expect(result.side).toBe('BUY');
    expect(result.type).toBe('MARKET');
    expect(result.status).toBe('FILLED');
    expect(result.avgPrice).toBe(50000);
    expect(result.filledQuantity).toBe(0.1);
    expect(result.commission).toBe(0.005);
  });
});

describe('parseAlgoUpdate', () => {
  test('parses ALGO_UPDATE into OrderResult', () => {
    const data = {
      e: 'ALGO_UPDATE',
      T: 1700000000000,
      o: {
        s: 'ETHUSDT',
        c: 'sl-456',
        S: 'SELL',
        o: 'STOP_MARKET',
        q: '1.0',
        p: '0',
        ap: '3200.00',
        X: 'FILLED',
        i: 67890,
        z: '1.0',
        n: '0.32',
        N: 'USDT',
        T: 1700000000200,
      },
    };
    const result = parseAlgoUpdate(data);
    expect(result.orderId).toBe('67890');
    expect(result.symbol).toBe('ETHUSDT');
    expect(result.side).toBe('SELL');
    expect(result.type).toBe('STOP_MARKET');
    expect(result.status).toBe('FILLED');
  });
});

describe('routeOrderType', () => {
  test('MARKET routes to order.place', () => {
    expect(routeOrderType('MARKET')).toBe('order.place');
  });

  test('LIMIT routes to order.place', () => {
    expect(routeOrderType('LIMIT')).toBe('order.place');
  });

  test('STOP_MARKET routes to algoOrder.place', () => {
    expect(routeOrderType('STOP_MARKET')).toBe('algoOrder.place');
  });

  test('TAKE_PROFIT_MARKET routes to algoOrder.place', () => {
    expect(routeOrderType('TAKE_PROFIT_MARKET')).toBe('algoOrder.place');
  });
});

describe('buildOrderParams', () => {
  test('builds MARKET order params with RESULT response type', () => {
    const params = buildOrderParams({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.1,
    });
    expect(params.symbol).toBe('BTCUSDT');
    expect(params.side).toBe('BUY');
    expect(params.type).toBe('MARKET');
    expect(params.quantity).toBe(0.1);
    expect(params.newOrderRespType).toBe('RESULT');
  });

  test('builds LIMIT order params with default GTC timeInForce', () => {
    const params = buildOrderParams({
      symbol: 'ETHUSDT',
      side: 'SELL',
      type: 'LIMIT',
      quantity: 1.0,
      price: 3500,
    });
    expect(params.price).toBe(3500);
    expect(params.timeInForce).toBe('GTC');
    expect(params.newOrderRespType).toBeUndefined();
  });

  test('builds STOP_MARKET order params with stopPrice', () => {
    const params = buildOrderParams({
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_MARKET',
      quantity: 0.1,
      stopPrice: 49000,
      reduceOnly: true,
    });
    expect(params.stopPrice).toBe(49000);
    expect(params.reduceOnly).toBe('true');
  });

  test('includes clientOrderId as newClientOrderId', () => {
    const params = buildOrderParams({
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.1,
      clientOrderId: 'my-order-1',
    });
    expect(params.newClientOrderId).toBe('my-order-1');
  });
});

describe('parseRestCandles', () => {
  test('parses REST kline array response', () => {
    const data = [
      [1700000000000, '50000', '50100', '49900', '50050', '100.5', 1700000059999, '5025000', 500],
    ];
    const candles = parseRestCandles(data);
    expect(candles).toHaveLength(1);
    expect(candles[0]!.openTime).toBe(1700000000000);
    expect(candles[0]!.close).toBe(50050);
    expect(candles[0]!.isClosed).toBe(true);
  });
});
