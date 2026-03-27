import type { IEventBus, TradingEventMap } from '@trading-bot/event-bus';
import type { PerformanceMetrics } from '@trading-bot/types';

import type { IStrategy, StrategyConfig, StrategyDeps, SignalBuffer, SignalMerge } from './types';

export class Strategy implements IStrategy {
  readonly name: string;
  private readonly bus: IEventBus;
  private readonly config: StrategyConfig;
  private readonly buffer: SignalBuffer;
  private readonly handler: (data: TradingEventMap['scanner:signal']) => void;

  constructor(config: StrategyConfig, deps: StrategyDeps) {
    this.name = config.name;
    this.bus = deps.bus;
    this.config = config;
    this.buffer = new Map();

    this.handler = (data) => {
      this.handleScannerSignal(data);
    };

    this.bus.on('scanner:signal', this.handler);
  }

  private handleScannerSignal(data: TradingEventMap['scanner:signal']): void {
    const { signal } = data;

    // Add to buffer keyed by sourceScanner
    const existing = this.buffer.get(signal.sourceScanner) ?? [];
    existing.push(signal);
    this.buffer.set(signal.sourceScanner, existing);

    // Prune signals outside the window
    const windowStart = signal.timestamp - this.config.signalBufferWindowMs;
    for (const [source, signals] of this.buffer) {
      const pruned = signals.filter((s) => s.timestamp >= windowStart);
      if (pruned.length === 0) {
        this.buffer.delete(source);
      } else {
        this.buffer.set(source, pruned);
      }
    }

    // Merge with a defensive snapshot so user-provided merge can't mutate internal state
    const snapshot: SignalBuffer = new Map();
    for (const [source, signals] of this.buffer) {
      snapshot.set(source, signals.slice());
    }
    let merged;
    try {
      merged = this.config.signalMerge(signal, snapshot);
    } catch {
      return; // merge function threw — drop this signal
    }
    if (merged !== null) {
      this.bus.emit('signal', { signal: merged });
    }
  }

  async start(): Promise<void> {
    // No-op: data-feed is started by the runner (backtest-engine or live-runner)
  }

  async stop(): Promise<void> {
    this.bus.off('scanner:signal', this.handler);
    for (const scanner of this.config.scanners) {
      scanner.dispose();
    }
    this.config.positionManager.dispose();
    this.config.riskManager.dispose();
  }

  getStats(): PerformanceMetrics {
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
  }
}

export const passthroughMerge: SignalMerge = (trigger) => trigger;
