import type { IEventBus, TradingEventMap } from '@trading-bot/event-bus';
import type { PositionSide } from '@trading-bot/types';

import type { IMarginGuard, MarginGuardConfig } from './types';

interface TrackedPosition {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  quantity: number;
}

export class MarginGuard implements IMarginGuard {
  private _isBreached = false;
  private readonly bus: IEventBus;
  private readonly config: MarginGuardConfig;
  private readonly positions = new Map<string, TrackedPosition[]>();
  private readonly markPrices = new Map<string, number>();
  private readonly disposers: (() => void)[] = [];

  constructor(bus: IEventBus, config: MarginGuardConfig) {
    this.bus = bus;
    this.config = config;
    const onOpened = (data: TradingEventMap['position:opened']): void => {
      this.handlePositionOpened(data);
    };
    const onClosed = (data: TradingEventMap['position:closed']): void => {
      this.handlePositionClosed(data);
    };

    bus.on('position:opened', onOpened);
    bus.on('position:closed', onClosed);
    this.disposers.push(
      () => bus.off('position:opened', onOpened),
      () => bus.off('position:closed', onClosed),
    );

    if (config.evaluationEvent === 'tick') {
      const onTick = (data: TradingEventMap['tick']): void => {
        this.updateMarkPrice(data.symbol, data.tick.price);
        this.evaluate();
      };
      bus.on('tick', onTick);
      this.disposers.push(() => bus.off('tick', onTick));
    } else {
      const onCandle = (data: TradingEventMap['candle:close']): void => {
        this.updateMarkPrice(data.symbol, data.candle.close);
        this.evaluate();
      };
      bus.on('candle:close', onCandle);
      this.disposers.push(() => bus.off('candle:close', onCandle));
    }
  }

  get isBreached(): boolean {
    return this._isBreached;
  }

  dispose(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
  }

  private handlePositionOpened(data: TradingEventMap['position:opened']): void {
    const { position } = data;
    const tracked: TrackedPosition = {
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
    };
    const existing = this.positions.get(position.symbol);
    if (existing) {
      existing.push(tracked);
    } else {
      this.positions.set(position.symbol, [tracked]);
    }
  }

  private handlePositionClosed(data: TradingEventMap['position:closed']): void {
    const { position } = data;
    const list = this.positions.get(position.symbol);
    if (!list) return;

    // Remove the first matching position (same side, entry price, quantity)
    const idx = list.findIndex(
      (p) =>
        p.side === position.side &&
        p.entryPrice === position.entryPrice &&
        p.quantity === position.quantity,
    );
    if (idx !== -1) {
      list.splice(idx, 1);
    }
    if (list.length === 0) {
      this.positions.delete(position.symbol);
    }
  }

  private updateMarkPrice(symbol: string, price: number): void {
    this.markPrices.set(symbol, price);
  }

  private evaluate(): void {
    if (this._isBreached) return;

    let totalUnrealizedPnl = 0;
    let totalNotional = 0;

    for (const [symbol, list] of this.positions) {
      const markPrice = this.markPrices.get(symbol);
      if (markPrice === undefined) {
        // Cannot evaluate without a mark price — skip but log via error event
        this.bus.emit('error', {
          source: 'margin-guard',
          error: new Error(`No mark price for ${symbol} with ${list.length} open position(s) — skipping from breach evaluation`),
        });
        continue;
      }

      for (const pos of list) {
        const direction = pos.side === 'LONG' ? 1 : -1;
        totalUnrealizedPnl += (markPrice - pos.entryPrice) * direction * pos.quantity;
        totalNotional += markPrice * pos.quantity;
      }
    }

    const unrealizedLossPct = (totalUnrealizedPnl / this.config.balance) * 100;
    const exposurePct = (totalNotional / this.config.balance) * 100;

    let breachMessage: string | undefined;

    if (unrealizedLossPct <= -this.config.maxUnrealizedLossPct) {
      breachMessage = `Unrealized loss ${unrealizedLossPct.toFixed(2)}% exceeds max ${this.config.maxUnrealizedLossPct}% of balance`;
    } else if (exposurePct >= this.config.maxTotalExposurePct) {
      breachMessage = `Total exposure ${exposurePct.toFixed(2)}% exceeds max ${this.config.maxTotalExposurePct}% of balance`;
    }

    if (breachMessage) {
      this._isBreached = true;
      this.bus.emit('risk:breach', {
        rule: 'MAX_DRAWDOWN',
        message: breachMessage,
        severity: 'KILL',
      });
    }
  }
}
