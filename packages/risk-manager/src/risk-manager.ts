import type { IEventBus, TradingEventMap } from '@trading-bot/event-bus';
import { KahanSum } from '@trading-bot/types';
import type { RiskCheckResult, Signal, TradeRecord } from '@trading-bot/types';

import type { IRiskManager, RiskConfig } from './types';

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
    if (config.maxPositionSizePct <= 0 || config.maxPositionSizePct > 100) {
      throw new Error(
        `RiskManager: maxPositionSizePct must be in (0, 100], got ${config.maxPositionSizePct}`,
      );
    }
    if (config.maxDailyLossPct < 0 || config.maxDailyLossPct > 100) {
      throw new Error(
        `RiskManager: maxDailyLossPct must be in [0, 100], got ${config.maxDailyLossPct}`,
      );
    }
    if (config.maxDrawdownPct < 0 || config.maxDrawdownPct > 100) {
      throw new Error(
        `RiskManager: maxDrawdownPct must be in [0, 100], got ${config.maxDrawdownPct}`,
      );
    }
    if (config.maxConcurrentPositions <= 0) {
      throw new Error(
        `RiskManager: maxConcurrentPositions must be > 0, got ${config.maxConcurrentPositions}`,
      );
    }
    if (config.maxDailyTrades <= 0) {
      throw new Error(`RiskManager: maxDailyTrades must be > 0, got ${config.maxDailyTrades}`);
    }
    if (config.initialBalance <= 0) {
      throw new Error(`RiskManager: initialBalance must be > 0, got ${config.initialBalance}`);
    }
    if (config.leverage <= 0) {
      throw new Error(`RiskManager: leverage must be > 0, got ${config.leverage}`);
    }

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
      // MAX_DAILY_LOSS kill switch resets at day boundary — the daily limit
      // is scoped to a single day. MAX_DRAWDOWN stays latched (account-level
      // concern that persists until explicit reset() or manual intervention).
      if (this.killSwitchActive && this.killSwitchRule === 'MAX_DAILY_LOSS') {
        this.killSwitchActive = false;
      }
    }
  }

  checkEntry(signal: Signal, entryPrice: number): RiskCheckResult {
    // Ensure daily counters are current for the signal's timestamp
    this.checkAndResetDaily(signal.timestamp);

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
    const dailyLossThreshold = -((this.config.initialBalance * this.config.maxDailyLossPct) / 100);
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

    // 7. Compute quantity (adjust entry price for expected slippage)
    const slippageBps = this.config.expectedSlippageBps ?? 0;
    const adjustedEntry = entryPrice * (1 + slippageBps / 10_000);
    const quantity =
      (((this.balance.value * this.config.maxPositionSizePct) / 100) * this.config.leverage) /
      adjustedEntry;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return {
        allowed: false,
        rule: 'MAX_POSITION_SIZE',
        reason: `Computed quantity is not valid: ${quantity}`,
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
