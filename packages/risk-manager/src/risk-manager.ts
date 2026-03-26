import type { RiskCheckResult, Signal, TradeRecord } from '@trading-bot/types';
import type { IEventBus, TradingEventMap } from '@trading-bot/event-bus';
import type { IRiskManager, RiskConfig } from './types';

// Kahan compensated summation — inline to avoid importing @trading-bot/reporting
// (boundary rule: scope:risk-manager may only depend on scope:types and scope:event-bus)
class KahanSum {
  private sum = 0;
  private compensation = 0;

  add(value: number): void {
    const y = value - this.compensation;
    const t = this.sum + y;
    this.compensation = t - this.sum - y;
    this.sum = t;
  }

  get value(): number {
    return this.sum;
  }

  reset(): void {
    this.sum = 0;
    this.compensation = 0;
  }
}

export class RiskManager implements IRiskManager {
  private readonly config: RiskConfig;

  // Balance tracking
  private balance: KahanSum;
  private peakBalance: number;

  // Position tracking
  private openPositionCount: number = 0;

  // Daily tracking
  private dailyTradeCount: number = 0;
  private dailyPnl: KahanSum;
  private currentDay: number;

  // Last trade info
  private lastTradeTimestamp: number | null = null;
  private lastTradePnl: number = 0;
  private lastTradeClosedAt: number | null = null;

  // Kill switch
  private killSwitchActive: boolean = false;
  private killSwitchRule: 'MAX_DAILY_LOSS' | 'MAX_DRAWDOWN' = 'MAX_DAILY_LOSS';

  // Event handlers (kept as references for dispose)
  private readonly handlePositionOpened: (data: TradingEventMap['position:opened']) => void;
  private readonly handlePositionClosed: (data: TradingEventMap['position:closed']) => void;
  private readonly handleOrderFilled: (data: TradingEventMap['order:filled']) => void;

  constructor(eventBus: IEventBus, config: RiskConfig) {
    this.config = config;

    this.balance = new KahanSum();
    this.balance.add(config.initialBalance);

    this.peakBalance = config.initialBalance;
    this.dailyPnl = new KahanSum();

    // Initialise currentDay to a sentinel that will not match any real timestamp day
    // so the first event always sets it correctly. Use 0 (epoch day 0).
    this.currentDay = 0;

    this.handlePositionOpened = (_data: TradingEventMap['position:opened']): void => {
      this.openPositionCount += 1;
    };

    this.handlePositionClosed = (data: TradingEventMap['position:closed']): void => {
      const trade: TradeRecord = data.trade;
      const timestamp = trade.exitTime;

      this.checkAndResetDaily(timestamp);

      this.openPositionCount = Math.max(0, this.openPositionCount - 1);
      this.balance.add(trade.pnl);
      this.dailyPnl.add(trade.pnl);

      if (this.balance.value > this.peakBalance) {
        this.peakBalance = this.balance.value;
      }

      this.lastTradePnl = trade.pnl;
      this.lastTradeClosedAt = timestamp;
    };

    this.handleOrderFilled = (data: TradingEventMap['order:filled']): void => {
      const timestamp = data.order.timestamp;

      this.checkAndResetDaily(timestamp);

      this.dailyTradeCount += 1;
      this.lastTradeTimestamp = timestamp;
    };

    eventBus.on('position:opened', this.handlePositionOpened);
    eventBus.on('position:closed', this.handlePositionClosed);
    eventBus.on('order:filled', this.handleOrderFilled);

    // Store the bus reference for dispose
    this.eventBus = eventBus;
  }

  // Stored for dispose
  private readonly eventBus: IEventBus;

  private checkAndResetDaily(timestamp: number): void {
    const day = Math.floor(timestamp / 86_400_000);
    if (day !== this.currentDay) {
      this.dailyTradeCount = 0;
      this.dailyPnl.reset();
      this.currentDay = day;
    }
  }

  checkEntry(signal: Signal, entryPrice: number): RiskCheckResult {
    // 1. Kill switch already active
    if (this.killSwitchActive) {
      return {
        allowed: false,
        rule: this.killSwitchRule,
        reason: `Kill switch active: ${this.killSwitchRule}`,
        severity: 'KILL',
      };
    }

    // 2. Max concurrent positions
    if (this.openPositionCount >= this.config.maxConcurrentPositions) {
      return {
        allowed: false,
        rule: 'MAX_CONCURRENT',
        reason: `Open positions (${this.openPositionCount}) >= limit (${this.config.maxConcurrentPositions})`,
        severity: 'REJECT',
      };
    }

    // 3. Max daily trades
    if (this.dailyTradeCount >= this.config.maxDailyTrades) {
      return {
        allowed: false,
        rule: 'MAX_DAILY_TRADES',
        reason: `Daily trades (${this.dailyTradeCount}) >= limit (${this.config.maxDailyTrades})`,
        severity: 'REJECT',
      };
    }

    // 4. Cooldown after loss
    if (
      this.lastTradePnl < 0 &&
      this.lastTradeClosedAt !== null &&
      signal.timestamp - this.lastTradeClosedAt < this.config.cooldownAfterLossMs
    ) {
      return {
        allowed: false,
        rule: 'COOLDOWN',
        reason: `Cooldown active after losing trade`,
        severity: 'REJECT',
      };
    }

    // 5. Max daily loss — check and potentially set kill switch
    const dailyLossThreshold = -(this.config.initialBalance * this.config.maxDailyLossPct / 100);
    if (this.dailyPnl.value <= dailyLossThreshold) {
      this.killSwitchActive = true;
      this.killSwitchRule = 'MAX_DAILY_LOSS';
      return {
        allowed: false,
        rule: 'MAX_DAILY_LOSS',
        reason: `Daily PnL (${this.dailyPnl.value.toFixed(2)}) <= threshold (${dailyLossThreshold.toFixed(2)})`,
        severity: 'KILL',
      };
    }

    // 6. Max drawdown — check and potentially set kill switch
    if (this.peakBalance > 0) {
      const drawdown = (this.peakBalance - this.balance.value) / this.peakBalance;
      if (drawdown >= this.config.maxDrawdownPct / 100) {
        this.killSwitchActive = true;
        this.killSwitchRule = 'MAX_DRAWDOWN';
        return {
          allowed: false,
          rule: 'MAX_DRAWDOWN',
          reason: `Drawdown (${(drawdown * 100).toFixed(2)}%) >= limit (${this.config.maxDrawdownPct}%)`,
          severity: 'KILL',
        };
      }
    }

    // 7. Compute quantity
    const quantity =
      (this.balance.value * this.config.maxPositionSizePct / 100 * this.config.leverage) /
      entryPrice;

    if (quantity <= 0) {
      return {
        allowed: false,
        rule: 'MAX_POSITION_SIZE',
        reason: `Computed quantity (${quantity}) <= 0`,
        severity: 'REJECT',
      };
    }

    // 8. All checks passed
    return { allowed: true, quantity };
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  reset(): void {
    this.balance.reset();
    this.balance.add(this.config.initialBalance);
    this.peakBalance = this.config.initialBalance;
    this.openPositionCount = 0;
    this.dailyTradeCount = 0;
    this.dailyPnl.reset();
    this.currentDay = 0;
    this.lastTradeTimestamp = null;
    this.lastTradePnl = 0;
    this.lastTradeClosedAt = null;
    this.killSwitchActive = false;
    this.killSwitchRule = 'MAX_DAILY_LOSS';
  }

  dispose(): void {
    this.eventBus.off('position:opened', this.handlePositionOpened);
    this.eventBus.off('position:closed', this.handlePositionClosed);
    this.eventBus.off('order:filled', this.handleOrderFilled);
  }
}
