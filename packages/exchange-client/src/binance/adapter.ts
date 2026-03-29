import type { IEventBus } from '@trading-bot/event-bus';
import type {
  AccountBalance,
  Candle,
  ExchangeConfig,
  FeeStructure,
  OrderBookDiff,
  OrderBookSnapshot,
  OrderRequest,
  OrderResult,
  Position,
  Tick,
  Timeframe,
} from '@trading-bot/types';
import { z } from 'zod';

import { ConnectionError, ExchangeApiError } from '../errors';
import type { IExchange } from '../types';
import {
  buildCombinedStreamUrl,
  buildStreamName,
  getEndpoints,
  toBinanceInterval,
  type BinanceEndpoints,
} from './endpoints';
import {
  buildOrderParams,
  parseAggTradeMessage,
  parseCombinedStreamMessage,
  parseDepthMessage,
  parseKlineMessage,
  parseRestCandles,
  parseRestOrderBook,
  parseWsApiOrderResponse,
  parseOrderTradeUpdate,
  parseAlgoUpdate,
  routeOrderType,
} from './parsers';
import { RequestTracker } from './request-tracker';
import { RestClient } from './rest-client';
import {
  PositionRiskSchema,
  BalanceEntrySchema,
  CommissionRateSchema,
  WsApiOrderResponseSchema,
} from './schemas';
import { signRequest } from './signing';
import { jsonParse } from './unsafe-cast';
import { WsConnection } from './ws-connection';

type StreamCallback = (data: unknown) => void;

interface BinanceTradingMessage {
  id?: string;
  status?: number;
  result?: unknown;
  error?: { code?: number; msg?: string };
  e?: string;
}

export class BinanceAdapter implements IExchange {
  private readonly endpoints: BinanceEndpoints;
  private apiKey: string;
  private privateKey: string;
  private readonly recvWindow: number;
  private readonly bus: IEventBus | null;

  private readonly tradingConn: WsConnection;
  private marketDataConn: WsConnection | null = null;
  private tradingConnected = false;
  private marketDataConnected = false;
  private marketDataConnecting = false;

  // Combined stream dispatch: stream name → callback
  private readonly streamCallbacks = new Map<string, StreamCallback[]>();
  private readonly activeStreams = new Set<string>();

  // WS API request tracking
  private readonly requestTracker = new RequestTracker();

  // Fill dedup: orderId:status → timestamp (bounded, entries older than 1h pruned)
  private readonly emittedFills = new Map<string, number>();
  private static readonly DEDUP_TTL_MS = 3_600_000; // 1 hour

  // REST client
  private readonly restClient: RestClient;

  // Per-stream-key last message timestamp for gap detection
  private readonly lastMessageTimestamp = new Map<string, number>();

  constructor(
    config: ExchangeConfig & { type: 'binance-live' | 'binance-testnet' },
    bus?: IEventBus,
  ) {
    this.endpoints = getEndpoints(config.type);
    this.apiKey = config.apiKey;
    this.privateKey = config.privateKey;
    this.recvWindow = config.recvWindow ?? 5000;
    this.bus = bus ?? null;

    this.restClient = new RestClient(this.endpoints.restBase, this.apiKey);

    this.tradingConn = new WsConnection('userData', {
      onConnected: (p) => this.bus?.emit('exchange:connected', p),
      onDisconnected: (p) => this.bus?.emit('exchange:disconnected', p),
      onReconnecting: (p) => this.bus?.emit('exchange:reconnecting', p),
      onReconnectExhausted: (p) => this.bus?.emit('risk:breach', p),
      onMessage: (data) => this.handleTradingMessage(data),
    });

    // After reconnect, re-authenticate and mark connected
    this.tradingConn.onReconnected = async () => {
      await this.sessionLogon();
      this.tradingConnected = true;
    };
  }

  // === Connection lifecycle ===

  async connect(): Promise<void> {
    if (this.tradingConnected) return;

    // Open trading WS API first (for auth)
    await this.tradingConn.open(this.endpoints.wsApi);

    try {
      // Authenticate via session.logon
      await this.sessionLogon();

      // Verify API key can trade by fetching account info
      await this.getBalance();
    } catch (err) {
      this.tradingConn.close();
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConnectionError(`Connection setup failed: ${msg}`);
    }

    this.tradingConnected = true;
  }

  async disconnect(): Promise<void> {
    this.tradingConnected = false;
    this.marketDataConnected = false;

    // Reject all pending WS API requests and clear their timers
    this.requestTracker.rejectAll('Disconnected');

    if (this.marketDataConn) {
      this.marketDataConn.close();
      this.marketDataConn = null;
    }

    this.tradingConn.close();

    this.streamCallbacks.clear();
    this.activeStreams.clear();
    this.emittedFills.clear();

    // Clear private keys from memory on intentional disconnect
    this.apiKey = '';
    this.privateKey = '';
  }

  isConnected(): boolean {
    if (!this.tradingConnected) return false;
    if (this.activeStreams.size > 0 && !this.marketDataConnected) return false;
    return true;
  }

  // === Market data subscriptions ===

  subscribeCandles(
    symbol: string,
    timeframe: Timeframe,
    callback: (candle: Candle) => void,
  ): () => void {
    const streamName = buildStreamName(symbol, `kline_${toBinanceInterval(timeframe)}`);
    return this.addStreamCallback(streamName, (data) => {
      callback(parseKlineMessage(data));
    });
  }

  subscribeTicks(symbol: string, callback: (tick: Tick) => void): () => void {
    const streamName = buildStreamName(symbol, 'aggTrade');
    return this.addStreamCallback(streamName, (data) => {
      callback(parseAggTradeMessage(data));
    });
  }

  subscribeOrderBookDiff(symbol: string, callback: (diff: OrderBookDiff) => void): () => void {
    const streamName = buildStreamName(symbol, 'depth@100ms');
    return this.addStreamCallback(streamName, (data) => {
      callback(parseDepthMessage(data));
    });
  }

  // === REST API: Market data ===

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const params = {
      symbol,
      interval: toBinanceInterval(timeframe),
      limit: String(limit),
    };
    const data = await this.restClient.restGet('/fapi/v1/klines', params);
    return parseRestCandles(data);
  }

  async getOrderBook(symbol: string, depth?: number): Promise<OrderBookSnapshot> {
    const params: Record<string, string> = { symbol };
    if (depth !== undefined) params.limit = String(depth);
    const data = await this.restClient.restGet('/fapi/v1/depth', params);
    return parseRestOrderBook(data, symbol);
  }

  // === REST API: Orders ===

  async placeOrder(request: OrderRequest): Promise<OrderResult> {
    const method = routeOrderType(request.type);
    const params = buildOrderParams(request);
    const requestTime = Date.now();
    const result = await this.wsApiRequest(method, params);
    return parseWsApiOrderResponse(result, requestTime);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.wsApiRequest('order.cancel', { symbol, orderId: Number(orderId) });
  }

  async getOpenOrders(symbol: string): Promise<OrderResult[]> {
    const params = { symbol };
    const requestTime = Date.now();
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    const data = await this.restClient.restGet('/fapi/v1/openOrders', signed);
    return z
      .array(WsApiOrderResponseSchema)
      .parse(data)
      .map((o) => parseWsApiOrderResponse(o, requestTime));
  }

  // === REST API: Positions ===

  async getPosition(symbol: string): Promise<Position | null> {
    const positions = await this.getPositions();
    return positions.find((p) => p.symbol === symbol) ?? null;
  }

  async getPositions(): Promise<Position[]> {
    const params = {};
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    const data = await this.restClient.restGet('/fapi/v2/positionRisk', signed);
    return z
      .array(PositionRiskSchema)
      .parse(data)
      .filter((p) => Number(p.positionAmt) !== 0)
      .map((p): Position => {
        const amt = Number(p.positionAmt);
        const side: Position['side'] = amt > 0 ? 'LONG' : 'SHORT';
        const marginType: Position['marginType'] =
          p.marginType.toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSS';
        return {
          symbol: p.symbol,
          side,
          entryPrice: Number(p.entryPrice),
          quantity: Math.abs(amt),
          unrealizedPnl: Number(p.unRealizedProfit),
          leverage: Number(p.leverage),
          liquidationPrice: Number(p.liquidationPrice),
          marginType,
          timestamp: Date.now(),
        };
      });
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const params = { symbol, leverage };
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    await this.restClient.restPost('/fapi/v1/leverage', signed);
  }

  // === REST API: Account ===

  async getBalance(): Promise<AccountBalance[]> {
    const params = {};
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    const data = await this.restClient.restGet('/fapi/v2/balance', signed);
    return z
      .array(BalanceEntrySchema)
      .parse(data)
      .map((b) => ({
        asset: b.asset,
        free: Number(b.availableBalance),
        locked: Number(b.balance) - Number(b.availableBalance),
        total: Number(b.balance),
      }));
  }

  async getFees(symbol: string): Promise<FeeStructure> {
    const params = { symbol };
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    const data = await this.restClient.restGet('/fapi/v1/commissionRate', signed);
    const resp = CommissionRateSchema.parse(data);
    return {
      maker: Number(resp.makerCommissionRate),
      taker: Number(resp.takerCommissionRate),
    };
  }

  // === Internal: Market data WS management ===

  private connectMarketDataWs(streams: string[]): Promise<void> {
    const url = buildCombinedStreamUrl(this.endpoints.wsStreams, streams);
    // Label as 'kline' since that's the primary market data stream;
    // gap events derive actual stream type from the stream key.
    const conn = new WsConnection('kline', {
      onConnected: (p) => {
        this.marketDataConnected = true;
        this.bus?.emit('exchange:connected', p);
      },
      onDisconnected: (p) => {
        this.marketDataConnected = false;
        this.bus?.emit('exchange:disconnected', p);
      },
      onReconnecting: (p) => this.bus?.emit('exchange:reconnecting', p),
      onReconnectExhausted: (p) => this.bus?.emit('risk:breach', p),
      onMessage: (data) => this.handleMarketDataMessage(data),
    });

    // After reconnect, emit gap events for each tracked stream
    conn.onReconnected = async () => {
      const reconnectTime = Date.now();
      for (const [streamKey, lastTs] of this.lastMessageTimestamp) {
        const streamType = streamKey.includes('kline') ? 'kline'
          : streamKey.includes('aggTrade') ? 'aggTrade'
          : 'depth';
        this.bus?.emit('exchange:gap', {
          stream: streamType,
          symbol: streamKey.split('@')[0]?.toUpperCase() ?? '*',
          fromTimestamp: lastTs,
          toTimestamp: reconnectTime,
          timestamp: reconnectTime,
        });
      }
    };

    this.marketDataConn = conn;
    return conn.open(url);
  }

  private handleMarketDataMessage(raw: string): void {
    try {
      const { stream, data } = parseCombinedStreamMessage(raw);

      // Track per-stream-key timestamp for gap detection
      this.lastMessageTimestamp.set(stream, Date.now());

      const callbacks = this.streamCallbacks.get(stream);
      if (callbacks) {
        for (const cb of callbacks) {
          try {
            cb(data);
          } catch (err) {
            this.logError('stream-callback', err, { stream });
          }
        }
      }
    } catch (err) {
      this.logError('parse-market-data', err);
    }
  }

  // === Internal: Trading WS message handling ===

  private handleTradingMessage(raw: string): void {
    try {
      const msg = jsonParse<BinanceTradingMessage>(raw);

      // WS API response (has 'id' field matching our request)
      if (typeof msg.id === 'string') {
        if (msg.status === 200) {
          this.requestTracker.resolve(msg.id, msg.result);
        } else {
          this.requestTracker.reject(
            msg.id,
            new ExchangeApiError(
              msg.error?.code ?? 0,
              `WS API error ${msg.error?.code ?? 0}: ${msg.error?.msg ?? 'Unknown error'}`,
            ),
          );
        }
        return;
      }

      // User data stream event
      if (msg.e === 'ORDER_TRADE_UPDATE') {
        const order = parseOrderTradeUpdate(msg);
        this.emitOrderEvent(order);
      } else if (msg.e === 'ALGO_UPDATE') {
        const order = parseAlgoUpdate(msg);
        this.emitOrderEvent(order);
      }
    } catch (err) {
      this.logError('parse-trading-message', err);
    }
  }

  private emitOrderEvent(order: OrderResult): void {
    if (!this.bus) return;

    // Dedup: don't emit twice for same orderId + status (bounded with TTL)
    const now = Date.now();
    const dedupeKey = `${order.orderId}:${order.status}:${order.filledQuantity}`;
    if (this.emittedFills.has(dedupeKey)) return;
    this.emittedFills.set(dedupeKey, now);

    // Prune old entries when map gets large
    if (this.emittedFills.size > 5000) {
      const cutoff = now - BinanceAdapter.DEDUP_TTL_MS;
      for (const [key, ts] of this.emittedFills) {
        if (ts < cutoff) this.emittedFills.delete(key);
      }
    }

    if (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED') {
      this.bus.emit('order:filled', { order });
    } else if (order.status === 'REJECTED' || order.status === 'EXPIRED') {
      this.bus.emit('order:rejected', {
        clientOrderId: order.clientOrderId,
        reason: `Order ${order.status}`,
      });
    } else if (order.status === 'CANCELED') {
      this.bus.emit('order:canceled', { order });
    }
  }

  // === Internal: WS API requests ===

  private async sessionLogon(): Promise<void> {
    const params: Record<string, string | number> = {
      apiKey: this.apiKey,
      timestamp: Date.now(),
    };
    if (this.recvWindow) {
      params.recvWindow = this.recvWindow;
    }
    await this.wsApiRequest('session.logon', params);
  }

  private async wsApiRequest(
    method: string,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const id = this.requestTracker.nextId();

    // Sign the params (add timestamp + signature) — async for Ed25519
    const signedParams = await signRequest(params, this.privateKey, this.recvWindow);

    const request = {
      id,
      method,
      params: signedParams,
    };

    const promise = this.requestTracker.track(id, method);
    try {
      this.tradingConn.send(JSON.stringify(request));
    } catch (err) {
      this.requestTracker.reject(id, err instanceof Error ? err : new Error(String(err)));
    }
    return promise;
  }

  // === Internal: Stream subscription management ===

  private addStreamCallback(streamName: string, callback: StreamCallback): () => void {
    let callbacks = this.streamCallbacks.get(streamName);
    if (!callbacks) {
      callbacks = [];
      this.streamCallbacks.set(streamName, callbacks);
    }
    callbacks.push(callback);

    // If market data WS isn't open yet, track the stream for when we connect
    this.activeStreams.add(streamName);

    // If we're connected but the WS isn't open (first subscription), open it
    if (this.tradingConnected && !this.marketDataConn && !this.marketDataConnecting) {
      this.marketDataConnecting = true;
      void this.connectMarketDataWs([...this.activeStreams]).finally(() => {
        this.marketDataConnecting = false;
      });
    }

    return () => {
      const cbs = this.streamCallbacks.get(streamName);
      if (cbs) {
        const idx = cbs.indexOf(callback);
        if (idx !== -1) cbs.splice(idx, 1);
        if (cbs.length === 0) {
          this.streamCallbacks.delete(streamName);
          this.activeStreams.delete(streamName);
        }
      }
    };
  }

  /**
   * Opens the market data WebSocket with all currently registered streams.
   * Called by LiveDataFeed after all subscriptions are registered.
   */
  async startMarketDataStream(): Promise<void> {
    if (this.activeStreams.size === 0) return;
    if (this.marketDataConn) return;
    await this.connectMarketDataWs([...this.activeStreams]);
  }

  private logError(action: string, err: unknown, context?: Record<string, unknown>): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.bus) {
      this.bus.emit('error', { source: 'exchange-client', error, context: { action, ...context } });
    }
  }
}
