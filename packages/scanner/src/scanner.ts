import type { IEventBus, TradingEventMap } from '@trading-bot/event-bus';
import type { IIndicator } from '@trading-bot/indicators';

import type { IScannerConfig, IScanner, ScannerEvaluate } from './types';

export class Scanner implements IScanner {
  readonly name: string;
  readonly config: IScannerConfig;

  private readonly bus: IEventBus;
  private readonly evaluate: ScannerEvaluate;
  private readonly indicatorInstances: Map<import('@trading-bot/types').Symbol, Map<string, IIndicator>>;
  private readonly handler: (data: TradingEventMap['candle:close']) => void;

  constructor(
    eventBus: IEventBus,
    name: string,
    config: IScannerConfig,
    evaluate: ScannerEvaluate,
  ) {
    this.bus = eventBus;
    this.name = name;
    this.config = config;
    this.evaluate = evaluate;
    this.indicatorInstances = new Map();

    this.handler = (data) => {
      this.handleCandleClose(data);
    };

    this.bus.on('candle:close', this.handler);
  }

  private handleCandleClose(data: TradingEventMap['candle:close']): void {
    if (data.timeframe !== this.config.timeframe) {
      return;
    }

    const { symbol, candle } = data;

    // Filter by configured symbols if non-empty
    if (this.config.symbols.length > 0 && !this.config.symbols.includes(symbol)) {
      return;
    }
    const indicators = this.getOrCreateIndicators(symbol);

    const values: Record<string, number> = {};
    let allWarmedUp = true;

    for (const [indicatorName, indicator] of indicators) {
      const result = indicator.update(candle);
      if (result === null) {
        allWarmedUp = false;
      } else {
        values[indicatorName] = result;
      }
    }

    if (!allWarmedUp) {
      return;
    }

    const result = this.evaluate(values, candle, symbol);
    if (result === null) {
      return;
    }

    this.bus.emit('scanner:signal', {
      signal: {
        ...result,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        symbol,
        sourceScanner: this.name,
        timestamp: candle.closeTime,
      },
    });
  }

  private getOrCreateIndicators(symbol: import('@trading-bot/types').Symbol): Map<string, IIndicator> {
    const existing = this.indicatorInstances.get(symbol);
    if (existing !== undefined) {
      return existing;
    }

    const instances = new Map<string, IIndicator>();
    for (const [indicatorName, factory] of Object.entries(this.config.indicators)) {
      instances.set(indicatorName, factory());
    }
    this.indicatorInstances.set(symbol, instances);
    return instances;
  }

  dispose(): void {
    this.bus.off('candle:close', this.handler);
  }
}

export function createScannerFactory(
  name: string,
  evaluate: ScannerEvaluate,
): import('./types').ScannerFactory {
  return (eventBus, config) => new Scanner(eventBus, name, config, evaluate);
}
