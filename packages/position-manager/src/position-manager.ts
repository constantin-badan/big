import type { IEventBus } from '@trading-bot/event-bus';
import type { IOrderExecutor } from '@trading-bot/order-executor';
import type { IRiskManager } from '@trading-bot/risk-manager';
import type {
  Candle,
  OrderRequest,
  OrderResult,
  Position,
  PositionSide,
  Signal,
  Tick,
  Timeframe,
  TradeRecord,
} from '@trading-bot/types';

import type { IPositionManager, PositionManagerConfig, PositionState } from './types';

type SymbolState = {
  state: PositionState;
  entryOrder: OrderResult | null;
  // Stored BEFORE calling submit() so re-entrant order:filled can match it
  pendingClientOrderId: string | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  peakPrice: number | null;
  trailingActive: boolean;
  entryTime: number | null;
  exitReason: TradeRecord['exitReason'] | null;
};

function makeSymbolState(): SymbolState {
  return {
    state: 'IDLE',
    entryOrder: null,
    pendingClientOrderId: null,
    stopPrice: null,
    takeProfitPrice: null,
    peakPrice: null,
    trailingActive: false,
    entryTime: null,
    exitReason: null,
  };
}

export class PositionManager implements IPositionManager {
  private readonly symbolStates = new Map<string, SymbolState>();
  private readonly lastTickPrice = new Map<string, number>();

  private readonly handleTick: (data: { symbol: string; tick: Tick }) => void;
  private readonly handleCandleClose: (data: {
    symbol: string;
    timeframe: Timeframe;
    candle: Candle;
  }) => void;

  private readonly handleSignal: (data: { signal: Signal }) => void;

  private readonly handleOrderFilled: (data: { order: OrderResult }) => void;
  private readonly handleOrderRejected: (data: { clientOrderId: string; reason: string }) => void;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly executor: IOrderExecutor,
    private readonly riskManager: IRiskManager,
    private readonly config: PositionManagerConfig,
  ) {
    if (config.defaultStopLossPct <= 0 || config.defaultStopLossPct >= 100) {
      throw new Error(
        `PositionManager: defaultStopLossPct must be in (0, 100), got ${config.defaultStopLossPct}`,
      );
    }
    if (config.defaultTakeProfitPct <= 0) {
      throw new Error(
        `PositionManager: defaultTakeProfitPct must be > 0, got ${config.defaultTakeProfitPct}`,
      );
    }
    if (config.maxHoldTimeMs <= 0) {
      throw new Error(`PositionManager: maxHoldTimeMs must be > 0, got ${config.maxHoldTimeMs}`);
    }
    if (config.trailingStopEnabled) {
      if (config.trailingStopActivationPct <= 0) {
        throw new Error(
          `PositionManager: trailingStopActivationPct must be > 0, got ${config.trailingStopActivationPct}`,
        );
      }
      if (config.trailingStopDistancePct <= 0) {
        throw new Error(
          `PositionManager: trailingStopDistancePct must be > 0, got ${config.trailingStopDistancePct}`,
        );
      }
    }

    // Bind handlers to named private methods
    this.handleTick = (data) => this.onTick(data);
    this.handleCandleClose = (data) => this.onCandleClose(data);
    this.handleSignal = (data) => this.onSignal(data);
    this.handleOrderFilled = (data) => this.onOrderFilled(data);
    this.handleOrderRejected = (data) => this.onOrderRejected(data);

    // ADR-8: Subscribe immediately in constructor
    this.eventBus.on('tick', this.handleTick);
    this.eventBus.on('candle:close', this.handleCandleClose);
    this.eventBus.on('signal', this.handleSignal);
    this.eventBus.on('order:filled', this.handleOrderFilled);
    this.eventBus.on('order:rejected', this.handleOrderRejected);
  }

  // === Event handler methods ===

  private onTick({ symbol, tick }: { symbol: string; tick: Tick }): void {
    this.lastTickPrice.set(symbol, tick.price);
    if (this.getState(symbol) === 'OPEN') {
      this.evaluateSLTP(symbol, tick.price, tick.timestamp);
    }
  }

  private onCandleClose({ symbol, candle }: { symbol: string; timeframe: Timeframe; candle: Candle }): void {
    if (this.getState(symbol) !== 'OPEN') return;
    const symState = this.getSymbolState(symbol);
    const entryOrder = symState.entryOrder;
    if (!entryOrder) return;

    const isLong = entryOrder.side === 'BUY';
    const closeTimestamp = candle.closeTime;
    const entryTime = symState.entryTime ?? closeTimestamp;

    // Check timeout
    if (closeTimestamp - entryTime > this.config.maxHoldTimeMs) {
      this.triggerExit(symbol, 'TIMEOUT', candle.close);
      return;
    }

    // Check trailing stop
    if (this.config.trailingStopEnabled) {
      const trailResult = this.checkTrailingStop(
        symState,
        isLong,
        entryOrder.avgPrice,
        candle.high,
        candle.low,
      );
      if (trailResult === 'TRIGGERED') {
        this.triggerExit(symbol, 'TRAILING_STOP', isLong ? candle.low : candle.high);
        return;
      }
    }

    // Check SL and TP — SL wins tiebreak
    const slHit =
      symState.stopPrice !== null &&
      (isLong ? candle.low <= symState.stopPrice : candle.high >= symState.stopPrice);
    const tpHit =
      symState.takeProfitPrice !== null &&
      (isLong ? candle.high >= symState.takeProfitPrice : candle.low <= symState.takeProfitPrice);

    if (slHit) {
      this.triggerExit(symbol, 'STOP_LOSS', symState.stopPrice ?? candle.close);
      return;
    }
    if (tpHit) {
      this.triggerExit(symbol, 'TAKE_PROFIT', symState.takeProfitPrice ?? candle.close);
    }
  }

  private onSignal({ signal }: { signal: Signal }): void {
    const { symbol, action } = signal;

    if (this.getState(symbol) !== 'IDLE') return;
    if (action === 'NO_ACTION') return;
    if (action === 'EXIT') return;

    const entryPrice = this.lastTickPrice.get(symbol) ?? signal.price;
    const result = this.riskManager.checkEntry(signal, entryPrice);

    if (!result.allowed) {
      if (result.severity === 'KILL') {
        this.eventBus.emit('risk:breach', {
          rule: result.rule,
          message: result.reason,
          severity: result.severity,
        });
      }
      return;
    }

    const symState = this.getSymbolState(symbol);
    const side = action === 'ENTER_LONG' ? 'BUY' : 'SELL';
    const isLong = action === 'ENTER_LONG';

    const stopPrice = isLong
      ? entryPrice * (1 - this.config.defaultStopLossPct / 100)
      : entryPrice * (1 + this.config.defaultStopLossPct / 100);
    const takeProfitPrice = isLong
      ? entryPrice * (1 + this.config.defaultTakeProfitPct / 100)
      : entryPrice * (1 - this.config.defaultTakeProfitPct / 100);

    // Generate clientOrderId upfront so it's stored BEFORE submit() is called
    // This ensures re-entrant order:filled can match it correctly (ADR-2)
    const clientOrderId = crypto.randomUUID();

    // State-before-emit: update all state before calling submit()
    symState.state = 'PENDING_ENTRY';
    symState.pendingClientOrderId = clientOrderId;
    symState.stopPrice = stopPrice;
    symState.takeProfitPrice = takeProfitPrice;
    symState.entryTime = signal.timestamp;
    symState.trailingActive = false;
    symState.exitReason = null;

    const request: OrderRequest = {
      symbol,
      side,
      type: 'MARKET',
      quantity: result.quantity,
      clientOrderId,
    };

    this.executor.submit(request);
  }

  private onOrderFilled({ order }: { order: OrderResult }): void {
    const symbol = order.symbol;
    const symState = this.symbolStates.get(symbol);
    if (!symState) return;

    // Match by the pre-stored clientOrderId
    if (symState.pendingClientOrderId !== order.clientOrderId) return;

    if (symState.state === 'PENDING_ENTRY') {
      // Transition PENDING_ENTRY → OPEN
      symState.entryOrder = order;
      symState.peakPrice = order.avgPrice;
      symState.state = 'OPEN';
      symState.pendingClientOrderId = null;

      const position = this.buildPositionFromEntry(symbol, order);
      this.eventBus.emit('position:opened', { position });
    } else if (symState.state === 'PENDING_EXIT') {
      const entry = symState.entryOrder;
      if (!entry) return;

      const trade = this.buildTradeRecord(symbol, symState, entry, order);
      const positionForClose = this.buildPositionFromEntry(symbol, entry);

      // State-before-emit: clear to IDLE before emitting
      this.resetToIdle(symState);

      this.eventBus.emit('position:closed', { position: positionForClose, trade });
    }
  }

  private onOrderRejected({ clientOrderId }: { clientOrderId: string; reason: string }): void {
    for (const [, symState] of this.symbolStates) {
      if (symState.pendingClientOrderId !== clientOrderId) continue;

      if (symState.state === 'PENDING_ENTRY') {
        this.resetToIdle(symState);
      } else if (symState.state === 'PENDING_EXIT') {
        symState.state = 'OPEN';
        symState.pendingClientOrderId = null;
      }
      break;
    }
  }

  // === Trailing stop extraction ===

  /**
   * Check trailing stop activation and breach.
   * Returns 'TRIGGERED' if trail breached, 'ACTIVATED' if just activated, null otherwise.
   */
  private checkTrailingStop(
    symState: SymbolState,
    isLong: boolean,
    entryPrice: number,
    currentHigh: number,
    currentLow: number,
  ): 'TRIGGERED' | 'ACTIVATED' | null {
    if (!symState.trailingActive) {
      const activated = isLong
        ? (currentHigh - entryPrice) / entryPrice >= this.config.trailingStopActivationPct / 100
        : (entryPrice - currentLow) / entryPrice >= this.config.trailingStopActivationPct / 100;
      if (activated) {
        symState.trailingActive = true;
        symState.peakPrice = isLong ? currentHigh : currentLow;
        return 'ACTIVATED';
      }
      return null;
    }

    if (symState.peakPrice !== null) {
      symState.peakPrice = isLong
        ? Math.max(symState.peakPrice, currentHigh)
        : Math.min(symState.peakPrice, currentLow);

      const trailBreached = isLong
        ? (symState.peakPrice - currentLow) / symState.peakPrice >=
          this.config.trailingStopDistancePct / 100
        : (currentHigh - symState.peakPrice) / symState.peakPrice >=
          this.config.trailingStopDistancePct / 100;

      if (trailBreached) {
        return 'TRIGGERED';
      }
    }

    return null;
  }

  // === Private helpers ===

  private getSymbolState(symbol: string): SymbolState {
    let state = this.symbolStates.get(symbol);
    if (!state) {
      state = makeSymbolState();
      this.symbolStates.set(symbol, state);
    }
    return state;
  }

  private resetToIdle(symState: SymbolState): void {
    symState.state = 'IDLE';
    symState.pendingClientOrderId = null;
    symState.entryOrder = null;
    symState.stopPrice = null;
    symState.takeProfitPrice = null;
    symState.peakPrice = null;
    symState.trailingActive = false;
    symState.entryTime = null;
    symState.exitReason = null;
  }

  private evaluateSLTP(symbol: string, price: number, timestamp: number): void {
    const symState = this.symbolStates.get(symbol);
    if (!symState || symState.state !== 'OPEN') return;

    const entry = symState.entryOrder;
    if (!entry) return;

    const isLong = entry.side === 'BUY';
    const entryTime = symState.entryTime ?? timestamp;

    // Timeout check first
    if (timestamp - entryTime > this.config.maxHoldTimeMs) {
      this.triggerExit(symbol, 'TIMEOUT', price);
      return;
    }

    // Trailing stop
    if (this.config.trailingStopEnabled) {
      const trailResult = this.checkTrailingStop(
        symState,
        isLong,
        entry.avgPrice,
        price,
        price,
      );
      if (trailResult === 'TRIGGERED') {
        this.triggerExit(symbol, 'TRAILING_STOP', price);
        return;
      }
    }

    // SL check
    if (symState.stopPrice !== null) {
      const slHit = isLong ? price <= symState.stopPrice : price >= symState.stopPrice;
      if (slHit) {
        this.triggerExit(symbol, 'STOP_LOSS', symState.stopPrice);
        return;
      }
    }

    // TP check
    if (symState.takeProfitPrice !== null) {
      const tpHit = isLong ? price >= symState.takeProfitPrice : price <= symState.takeProfitPrice;
      if (tpHit) {
        this.triggerExit(symbol, 'TAKE_PROFIT', symState.takeProfitPrice);
      }
    }
  }

  private triggerExit(symbol: string, reason: TradeRecord['exitReason'], fillPrice: number): void {
    const symState = this.symbolStates.get(symbol);
    if (!symState || symState.state !== 'OPEN') return;

    const entry = symState.entryOrder;
    if (!entry) return;

    let orderType: OrderRequest['type'];
    if (reason === 'STOP_LOSS' || reason === 'TRAILING_STOP') {
      orderType = 'STOP_MARKET';
    } else if (reason === 'TAKE_PROFIT') {
      orderType = 'TAKE_PROFIT_MARKET';
    } else {
      orderType = 'MARKET';
    }

    const exitSide = entry.side === 'BUY' ? 'SELL' : 'BUY';

    // Generate clientOrderId upfront before submit() — ADR-2 re-entrancy safety
    const clientOrderId = crypto.randomUUID();

    // State-before-emit: update state before submit()
    symState.state = 'PENDING_EXIT';
    symState.exitReason = reason;
    symState.pendingClientOrderId = clientOrderId;

    const request: OrderRequest = {
      symbol,
      side: exitSide,
      type: orderType,
      quantity: entry.filledQuantity,
      stopPrice: fillPrice,
      reduceOnly: true,
      clientOrderId,
    };

    this.executor.submit(request);
  }

  private buildPositionFromEntry(symbol: string, entry: OrderResult): Position {
    const side: PositionSide = entry.side === 'BUY' ? 'LONG' : 'SHORT';
    const currentPrice = this.lastTickPrice.get(symbol) ?? entry.avgPrice;
    const direction = entry.side === 'BUY' ? 1 : -1;
    const unrealizedPnl = (currentPrice - entry.avgPrice) * direction * entry.filledQuantity;

    return {
      symbol,
      side,
      entryPrice: entry.avgPrice,
      quantity: entry.filledQuantity,
      unrealizedPnl,
      leverage: 1,
      liquidationPrice: 0,
      marginType: 'ISOLATED',
      timestamp: entry.timestamp,
    };
  }

  private buildTradeRecord(
    symbol: string,
    symState: SymbolState,
    entryOrder: OrderResult,
    exitOrder: OrderResult,
  ): TradeRecord {
    const side: PositionSide = entryOrder.side === 'BUY' ? 'LONG' : 'SHORT';
    const direction = entryOrder.side === 'BUY' ? 1 : -1;
    const pnl =
      (exitOrder.avgPrice - entryOrder.avgPrice) * direction * exitOrder.filledQuantity -
      entryOrder.commission -
      exitOrder.commission;
    let requestedExitPrice: number;
    switch (symState.exitReason) {
      case 'TAKE_PROFIT':
        requestedExitPrice = symState.takeProfitPrice ?? exitOrder.price;
        break;
      case 'TRAILING_STOP': {
        // Trailing stop trigger price = peak * (1 - distance%) for longs,
        // peak * (1 + distance%) for shorts
        const isLongExit = entryOrder.side === 'BUY';
        const distanceMult = this.config.trailingStopDistancePct / 100;
        requestedExitPrice =
          symState.peakPrice !== null
            ? isLongExit
              ? symState.peakPrice * (1 - distanceMult)
              : symState.peakPrice * (1 + distanceMult)
            : exitOrder.price;
        break;
      }
      case 'STOP_LOSS':
        requestedExitPrice = symState.stopPrice ?? exitOrder.price;
        break;
      default:
        // SIGNAL / TIMEOUT — no "intended" price, slippage is 0
        requestedExitPrice = exitOrder.avgPrice;
    }
    const slippage = Math.abs(exitOrder.avgPrice - requestedExitPrice);
    const entryTime = symState.entryTime ?? entryOrder.timestamp;
    const exitTime = exitOrder.timestamp;

    return {
      id: crypto.randomUUID(),
      symbol,
      side,
      entryPrice: entryOrder.avgPrice,
      exitPrice: exitOrder.avgPrice,
      quantity: exitOrder.filledQuantity,
      entryTime,
      exitTime,
      pnl,
      fees: entryOrder.commission + exitOrder.commission,
      slippage,
      holdTimeMs: exitTime - entryTime,
      exitReason: symState.exitReason ?? 'SIGNAL',
      metadata: {},
    };
  }

  getState(symbol: string): PositionState {
    return this.symbolStates.get(symbol)?.state ?? 'IDLE';
  }

  hasOpenPosition(symbol: string): boolean {
    return this.getState(symbol) === 'OPEN';
  }

  hasPendingOrder(symbol: string): boolean {
    const state = this.getState(symbol);
    return state === 'PENDING_ENTRY' || state === 'PENDING_EXIT';
  }

  getOpenPositions(): Position[] {
    const positions: Position[] = [];
    for (const [symbol, symState] of this.symbolStates) {
      if (symState.state === 'OPEN' && symState.entryOrder) {
        positions.push(this.buildPositionFromEntry(symbol, symState.entryOrder));
      }
    }
    return positions;
  }

  dispose(): void {
    this.eventBus.off('tick', this.handleTick);
    this.eventBus.off('candle:close', this.handleCandleClose);
    this.eventBus.off('signal', this.handleSignal);
    this.eventBus.off('order:filled', this.handleOrderFilled);
    this.eventBus.off('order:rejected', this.handleOrderRejected);
  }
}
