import type {
  AccountBalance,
  Candle,
  FeeStructure,
  IEventBus,
  IExchange,
  IFillSimulator,
  OrderBookDiff,
  OrderBookSnapshot,
  OrderRequest,
  OrderResult,
  Position,
  SlippageModel,
  Symbol,
  Tick,
  Timeframe,
} from '@trading-bot/types';
import { toOrderId, toClientOrderId } from '@trading-bot/types';

interface BacktestExchangeConfig {
  feeStructure: FeeStructure;
  slippageModel: SlippageModel & { type: 'fixed' };
  initialBalance: number;
  leverage: number; // for margin check: required margin = notional / leverage
}

export class BacktestSimExchange implements IExchange, IFillSimulator {
  private readonly bus: IEventBus;
  private readonly feeStructure: FeeStructure;
  private readonly slippageBps: number;
  private readonly initialBalance: number;
  private readonly leverage: number;
  private balance: number;
  private readonly currentPrices = new Map<string, number>();
  private readonly handler: (data: {
    symbol: string;
    timeframe: Timeframe;
    candle: Candle;
  }) => void;
  private orderCounter = 0;
  private currentTimestamp = Date.now(); // fallback; overwritten by first candle:close

  constructor(bus: IEventBus, config: BacktestExchangeConfig) {
    this.bus = bus;
    this.feeStructure = config.feeStructure;
    this.initialBalance = config.initialBalance;
    this.leverage = config.leverage;
    this.balance = config.initialBalance;

    this.slippageBps = config.slippageModel.fixedBps;

    this.handler = (data) => {
      this.currentPrices.set(data.symbol, data.candle.close);
      this.currentTimestamp = data.candle.closeTime;
    };
    bus.on('candle:close', this.handler);
  }

  // --- IFillSimulator ---

  simulateFill(request: OrderRequest): OrderResult {
    const currentPrice = this.currentPrices.get(request.symbol);
    if (currentPrice === undefined) {
      return this.makeRejected(request, 'No price data for symbol');
    }

    const slippageMult = this.slippageBps / 10_000;

    switch (request.type) {
      case 'MARKET':
        return this.fillMarket(request, currentPrice, slippageMult);
      case 'LIMIT':
        return this.fillLimit(request, currentPrice);
      case 'STOP_MARKET':
        return this.fillStop(request, currentPrice, slippageMult);
      case 'TAKE_PROFIT_MARKET':
        return this.fillTakeProfit(request, currentPrice, slippageMult);
    }
  }

  private fillMarket(request: OrderRequest & { type: 'MARKET' }, basePrice: number, slippageMult: number): OrderResult {
    const direction = request.side === 'BUY' ? 1 : -1;
    const fillPrice = basePrice * (1 + direction * slippageMult);
    return this.makeFilled(request, fillPrice);
  }

  private fillLimit(request: OrderRequest & { type: 'LIMIT' }, currentPrice: number): OrderResult {
    // BUY LIMIT fills when market <= limit; SELL LIMIT fills when market >= limit
    const canFill =
      request.side === 'BUY' ? currentPrice <= request.price : currentPrice >= request.price;
    if (!canFill) {
      return this.makeRejected(request, 'LIMIT price not crossed');
    }
    return this.makeFilled(request, request.price);
  }

  private fillStop(request: OrderRequest & { type: 'STOP_MARKET' }, currentPrice: number, slippageMult: number): OrderResult {
    // BUY STOP triggers when price >= stop; SELL STOP triggers when price <= stop
    const triggered =
      request.side === 'BUY'
        ? currentPrice >= request.stopPrice
        : currentPrice <= request.stopPrice;
    if (!triggered) {
      return this.makeRejected(request, 'STOP_MARKET not triggered');
    }
    const direction = request.side === 'BUY' ? 1 : -1;
    const fillPrice = request.stopPrice * (1 + direction * slippageMult);
    return this.makeFilled(request, fillPrice);
  }

  private fillTakeProfit(
    request: OrderRequest & { type: 'TAKE_PROFIT_MARKET' },
    currentPrice: number,
    slippageMult: number,
  ): OrderResult {
    // BUY TP triggers when price <= stop; SELL TP triggers when price >= stop
    const triggered =
      request.side === 'BUY'
        ? currentPrice <= request.stopPrice
        : currentPrice >= request.stopPrice;
    if (!triggered) {
      return this.makeRejected(request, 'TAKE_PROFIT_MARKET not triggered');
    }
    const direction = request.side === 'BUY' ? 1 : -1;
    const fillPrice = request.stopPrice * (1 + direction * slippageMult);
    return this.makeFilled(request, fillPrice);
  }

  private makeFilled(request: OrderRequest, fillPrice: number): OrderResult {
    const feeRate = request.type === 'LIMIT' ? this.feeStructure.maker : this.feeStructure.taker;
    const fee = request.quantity * fillPrice * feeRate;
    const notional = request.quantity * fillPrice;
    // Margin check: required margin = notional / leverage + fee.
    // Uses margin-based check but full-notional balance tracking so that
    // round-trip PnL = (exitPrice - entryPrice) * qty - fees, regardless of leverage.
    const requiredMargin = notional / this.leverage + fee;
    if (this.balance < requiredMargin) {
      return this.makeRejected(
        request,
        `Insufficient margin: need ${requiredMargin.toFixed(2)}, have ${this.balance.toFixed(2)}`,
      );
    }
    // Full-notional balance tracking: BUY reduces by notional + fee, SELL increases by notional - fee.
    // Balance may go negative during open positions — this is expected and correct.
    if (request.side === 'BUY') {
      this.balance -= notional + fee;
    } else {
      this.balance += notional - fee;
    }
    this.orderCounter += 1;
    return {
      orderId: toOrderId(`sim-${this.orderCounter}`),
      clientOrderId: request.clientOrderId ?? toClientOrderId(`sim-${this.orderCounter}`),
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: 'FILLED',
      price: fillPrice,
      avgPrice: fillPrice,
      quantity: request.quantity,
      filledQuantity: request.quantity,
      commission: fee,
      commissionAsset: 'USDT',
      timestamp: this.currentTimestamp,
      latencyMs: 0,
    };
  }

  private makeRejected(request: OrderRequest, _reason: string): OrderResult {
    this.orderCounter += 1;
    return {
      orderId: toOrderId(`sim-${this.orderCounter}`),
      clientOrderId: request.clientOrderId ?? toClientOrderId(`sim-${this.orderCounter}`),
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: 'REJECTED',
      price: 0,
      avgPrice: 0,
      quantity: request.quantity,
      filledQuantity: 0,
      commission: 0,
      commissionAsset: 'USDT',
      timestamp: this.currentTimestamp,
      latencyMs: 0,
    };
  }

  resetBalance(balance: number): void {
    this.balance = balance;
  }

  dispose(): void {
    this.bus.off('candle:close', this.handler);
  }

  // --- IExchange stubs (not used during replay) ---

  getCandles(): Promise<Candle[]> {
    return Promise.resolve([]);
  }

  getOrderBook(symbol: Symbol): Promise<OrderBookSnapshot> {
    return Promise.resolve({ symbol, timestamp: 0, bids: [], asks: [] });
  }

  subscribeCandles(_s: string, _t: Timeframe, _cb: (c: Candle) => void): () => void {
    return () => {};
  }

  subscribeTicks(_s: string, _cb: (t: Tick) => void): () => void {
    return () => {};
  }

  subscribeOrderBookDiff(_s: string, _cb: (d: OrderBookDiff) => void): () => void {
    return () => {};
  }

  placeOrder(request: OrderRequest): Promise<OrderResult> {
    return Promise.resolve(this.simulateFill(request));
  }

  cancelOrder(): Promise<void> {
    return Promise.resolve();
  }

  getOpenOrders(): Promise<OrderResult[]> {
    return Promise.resolve([]);
  }

  getPosition(): Promise<Position | null> {
    return Promise.resolve(null);
  }

  getPositions(): Promise<Position[]> {
    return Promise.resolve([]);
  }

  setLeverage(): Promise<void> {
    return Promise.resolve();
  }

  getBalance(): Promise<AccountBalance[]> {
    return Promise.resolve([{ asset: 'USDT', free: this.balance, locked: 0, total: this.balance }]);
  }

  getFees(): Promise<FeeStructure> {
    return Promise.resolve(this.feeStructure);
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  isConnected(): boolean {
    return true;
  }
}
