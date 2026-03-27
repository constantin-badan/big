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
import { buildQueryString, signRequest } from './signing';
import { jsonParse, unsafeCast } from './unsafe-cast';

type StreamCallback = (data: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  requestTime: number;
  timer: ReturnType<typeof setTimeout>;
}

// Binance REST response shapes (unvalidated — verified by integration tests)
interface BinancePositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  unRealizedProfit: string;
  leverage: string;
  liquidationPrice: string;
  marginType: string;
}

interface BinanceBalanceEntry {
  asset: string;
  balance: string;
  availableBalance: string;
}

interface BinanceCommissionRate {
  makerCommissionRate: string;
  takerCommissionRate: string;
}

interface BinanceTradingMessage {
  id?: string;
  status?: number;
  result?: unknown;
  error?: { code?: number; msg?: string };
  e?: string;
}

// Reconnection config
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 500;
const RECONNECT_KILL_AFTER = 10;
const WS_REQUEST_TIMEOUT_MS = 30_000;

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
  const jitter = Math.random() * RECONNECT_JITTER_MS;
  return exponential + jitter;
}

export class BinanceAdapter implements IExchange {
  private readonly endpoints: BinanceEndpoints;
  private readonly apiKey: string;
  private readonly privateKey: string;
  private readonly recvWindow: number;
  private readonly bus: IEventBus | null;

  private marketDataWs: WebSocket | null = null;
  private tradingWs: WebSocket | null = null;
  private tradingConnected = false;
  private marketDataConnected = false;
  private intentionalDisconnect = false;

  // Reconnection locks — prevent concurrent reconnect loops
  private reconnectingTrading = false;
  private reconnectingMarketData = false;

  // Combined stream dispatch: stream name → callback
  private readonly streamCallbacks = new Map<string, StreamCallback[]>();
  private readonly activeStreams = new Set<string>();

  // WS API request tracking: id → pending promise
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private requestIdCounter = 0;

  // Fill dedup: orderId → already emitted
  private readonly emittedFills = new Set<string>();

  // Reconnection state
  private marketDataReconnectAttempt = 0;
  private tradingReconnectAttempt = 0;

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
  }

  // === Connection lifecycle ===

  async connect(): Promise<void> {
    if (this.tradingConnected) return;

    // Open trading WS API first (for auth)
    await this.connectTradingWs();

    // Authenticate via session.logon
    await this.sessionLogon();

    this.tradingConnected = true;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.tradingConnected = false;
    this.marketDataConnected = false;

    // Reject all pending WS API requests and clear their timers
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();

    if (this.marketDataWs) {
      this.marketDataWs.close();
      this.marketDataWs = null;
    }

    if (this.tradingWs) {
      this.tradingWs.close();
      this.tradingWs = null;
    }

    this.streamCallbacks.clear();
    this.activeStreams.clear();
    this.emittedFills.clear();
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

  subscribeOrderBookDiff(
    symbol: string,
    callback: (diff: OrderBookDiff) => void,
  ): () => void {
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
    const data = await this.restGet('/fapi/v1/klines', params);
    return parseRestCandles(data);
  }

  async getOrderBook(symbol: string, depth?: number): Promise<OrderBookSnapshot> {
    const params: Record<string, string> = { symbol };
    if (depth !== undefined) params.limit = String(depth);
    const data = await this.restGet('/fapi/v1/depth', params);
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
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    const data = await this.restGet('/fapi/v1/openOrders', signed);
    return unsafeCast<Array<Record<string, unknown>>>(data).map((o) =>
      parseWsApiOrderResponse(o, Date.now()),
    );
  }

  // === REST API: Positions ===

  async getPosition(symbol: string): Promise<Position | null> {
    const positions = await this.getPositions();
    return positions.find((p) => p.symbol === symbol) ?? null;
  }

  async getPositions(): Promise<Position[]> {
    const params = {};
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    const data = await this.restGet('/fapi/v2/positionRisk', signed);
    return unsafeCast<BinancePositionRisk[]>(data)
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
    await this.restPost('/fapi/v1/leverage', signed);
  }

  // === REST API: Account ===

  async getBalance(): Promise<AccountBalance[]> {
    const params = {};
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    const data = await this.restGet('/fapi/v2/balance', signed);
    return unsafeCast<BinanceBalanceEntry[]>(data).map((b) => ({
      asset: b.asset,
      free: Number(b.availableBalance),
      locked: Number(b.balance) - Number(b.availableBalance),
      total: Number(b.balance),
    }));
  }

  async getFees(symbol: string): Promise<FeeStructure> {
    const params = { symbol };
    const signed = await signRequest(params, this.privateKey, this.recvWindow);
    const data = await this.restGet('/fapi/v1/commissionRate', signed);
    const resp = unsafeCast<BinanceCommissionRate>(data);
    return {
      maker: Number(resp.makerCommissionRate),
      taker: Number(resp.takerCommissionRate),
    };
  }

  // === Internal: WebSocket management ===

  private connectTradingWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoints.wsApi);
      let resolved = false;

      ws.addEventListener('open', () => {
        this.tradingWs = ws;
        this.tradingReconnectAttempt = 0;
        if (!resolved) {
          resolved = true;
          resolve();
        }
        this.bus?.emit('exchange:connected', {
          stream: 'userData',
          symbol: '*',
          timestamp: Date.now(),
        });
      });

      ws.addEventListener('error', () => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Trading WS connection failed'));
        }
      });

      ws.addEventListener('message', (event) => {
        this.handleTradingMessage(String(event.data));
      });

      ws.addEventListener('close', () => {
        this.tradingWs = null;
        this.tradingConnected = false;
        if (this.intentionalDisconnect) return;

        this.bus?.emit('exchange:disconnected', {
          stream: 'userData',
          symbol: '*',
          reason: 'server_close',
          timestamp: Date.now(),
        });

        void this.reconnectTrading();
      });
    });
  }

  private async reconnectTrading(): Promise<void> {
    if (this.reconnectingTrading) return;
    this.reconnectingTrading = true;
    try {
      while (!this.intentionalDisconnect) {
        this.tradingReconnectAttempt++;
        const delay = reconnectDelay(this.tradingReconnectAttempt);

        this.bus?.emit('exchange:reconnecting', {
          stream: 'userData',
          symbol: '*',
          attempt: this.tradingReconnectAttempt,
          timestamp: Date.now(),
        });

        if (this.tradingReconnectAttempt >= RECONNECT_KILL_AFTER) {
          this.bus?.emit('risk:breach', {
            rule: 'MAX_DAILY_LOSS',
            message: `Trading WS reconnect failed after ${this.tradingReconnectAttempt} attempts`,
            severity: 'KILL',
          });
        }

        await new Promise<void>((r) => setTimeout(r, delay));
        if (this.intentionalDisconnect) return;

        try {
          await this.connectTradingWs();
          await this.sessionLogon();
          this.tradingConnected = true;
          return;
        } catch {
          // retry
        }
      }
    } finally {
      this.reconnectingTrading = false;
    }
  }

  private connectMarketDataWs(streams: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = buildCombinedStreamUrl(this.endpoints.wsStreams, streams);
      const ws = new WebSocket(url);
      let resolved = false;

      ws.addEventListener('open', () => {
        this.marketDataWs = ws;
        this.marketDataConnected = true;
        this.marketDataReconnectAttempt = 0;
        if (!resolved) {
          resolved = true;
          resolve();
        }
        this.bus?.emit('exchange:connected', {
          stream: 'kline',
          symbol: '*',
          timestamp: Date.now(),
        });
      });

      ws.addEventListener('error', () => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Market data WS connection failed'));
        }
      });

      ws.addEventListener('message', (event) => {
        this.handleMarketDataMessage(String(event.data));
      });

      ws.addEventListener('close', () => {
        this.marketDataWs = null;
        this.marketDataConnected = false;
        if (this.intentionalDisconnect) return;

        this.bus?.emit('exchange:disconnected', {
          stream: 'kline',
          symbol: '*',
          reason: 'server_close',
          timestamp: Date.now(),
        });

        void this.reconnectMarketData(streams);
      });
    });
  }

  private async reconnectMarketData(streams: string[]): Promise<void> {
    if (this.reconnectingMarketData) return;
    this.reconnectingMarketData = true;
    try {
      while (!this.intentionalDisconnect) {
        this.marketDataReconnectAttempt++;
        const delay = reconnectDelay(this.marketDataReconnectAttempt);

        this.bus?.emit('exchange:reconnecting', {
          stream: 'kline',
          symbol: '*',
          attempt: this.marketDataReconnectAttempt,
          timestamp: Date.now(),
        });

        if (this.marketDataReconnectAttempt >= RECONNECT_KILL_AFTER) {
          this.bus?.emit('risk:breach', {
            rule: 'MAX_DAILY_LOSS',
            message: `Market data WS reconnect failed after ${this.marketDataReconnectAttempt} attempts`,
            severity: 'KILL',
          });
        }

        await new Promise<void>((r) => setTimeout(r, delay));
        if (this.intentionalDisconnect) return;

        try {
          await this.connectMarketDataWs(streams);

          // Emit gap events for each tracked stream
          const reconnectTime = Date.now();
          for (const [streamKey, lastTs] of this.lastMessageTimestamp) {
            this.bus?.emit('exchange:gap', {
              stream: 'kline',
              symbol: streamKey.split('@')[0]?.toUpperCase() ?? '*',
              fromTimestamp: lastTs,
              toTimestamp: reconnectTime,
              timestamp: reconnectTime,
            });
          }
          return;
        } catch {
          // retry
        }
      }
    } finally {
      this.reconnectingMarketData = false;
    }
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
            console.error(`[BinanceAdapter] Stream callback error for ${stream}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('[BinanceAdapter] Failed to parse market data message:', err);
    }
  }

  private handleTradingMessage(raw: string): void {
    try {
      const msg = jsonParse<BinanceTradingMessage>(raw);

      // WS API response (has 'id' field matching our request)
      if (typeof msg.id === 'string') {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          if (msg.status === 200) {
            pending.resolve(msg.result);
          } else {
            pending.reject(
              new Error(`WS API error ${msg.error?.code}: ${msg.error?.msg ?? 'Unknown error'}`),
            );
          }
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
      console.error('[BinanceAdapter] Failed to parse trading message:', err);
    }
  }

  private emitOrderEvent(order: OrderResult): void {
    if (!this.bus) return;

    // Dedup: don't emit twice for same orderId + status
    const dedupeKey = `${order.orderId}:${order.status}`;
    if (this.emittedFills.has(dedupeKey)) return;
    this.emittedFills.add(dedupeKey);

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
    if (!this.tradingWs) {
      throw new Error('Trading WS not connected');
    }

    const id = String(++this.requestIdCounter);

    // Sign the params (add timestamp + signature) — async for Ed25519
    const signedParams = await signRequest(params, this.privateKey, this.recvWindow);

    const request = {
      id,
      method,
      params: signedParams,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`WS API request timed out after ${WS_REQUEST_TIMEOUT_MS}ms: ${method}`));
      }, WS_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, requestTime: Date.now(), timer });
      this.tradingWs!.send(JSON.stringify(request));
    });
  }

  // === Internal: REST requests ===

  private async restGet(
    path: string,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const qs = buildQueryString(params);
    const url = `${this.endpoints.restBase}${path}?${qs}`;
    const response = await fetch(url, {
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Binance REST ${response.status}: ${body}`);
    }
    return response.json();
  }

  private async restPost(
    path: string,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const url = `${this.endpoints.restBase}${path}`;
    const body = buildQueryString(params);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Binance REST ${response.status}: ${respBody}`);
    }
    return response.json();
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
    if (this.tradingConnected && !this.marketDataWs) {
      void this.connectMarketDataWs([...this.activeStreams]);
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
    if (this.marketDataWs) return;
    await this.connectMarketDataWs([...this.activeStreams]);
  }
}
