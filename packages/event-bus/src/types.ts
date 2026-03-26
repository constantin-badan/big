import type {
  Candle,
  ExchangeStream,
  OrderResult,
  Position,
  RiskRule,
  RiskSeverity,
  Signal,
  SubmissionReceipt,
  Tick,
  Timeframe,
  TradeRecord,
} from '@trading-bot/types';

export interface TradingEventMap {
  'candle:close': { symbol: string; timeframe: Timeframe; candle: Candle };
  'candle:update': { symbol: string; timeframe: Timeframe; candle: Candle };
  'tick': { symbol: string; tick: Tick };

  'scanner:signal': { signal: Signal };
  'signal': { signal: Signal };

  'order:submitted': { receipt: SubmissionReceipt };
  'order:filled': { order: OrderResult };
  'order:rejected': { clientOrderId: string; reason: string };
  'order:canceled': { order: OrderResult };

  'position:opened': { position: Position };
  'position:updated': { position: Position };
  'position:closed': { position: Position; trade: TradeRecord };

  'risk:breach': { rule: RiskRule; message: string; severity: RiskSeverity };

  'exchange:connected': {
    stream: ExchangeStream;
    symbol: string;
    timestamp: number;
  };
  'exchange:disconnected': {
    stream: ExchangeStream;
    symbol: string;
    reason: 'ping_timeout' | 'server_close' | 'network_error' | 'manual';
    timestamp: number;
  };
  'exchange:reconnecting': {
    stream: ExchangeStream;
    symbol: string;
    attempt: number;
    timestamp: number;
  };
  'exchange:gap': {
    stream: ExchangeStream;
    symbol: string;
    fromTimestamp: number;
    toTimestamp: number;
    missedCandles?: number;
    timestamp: number;
  };

  'error': { source: string; error: Error; context?: Record<string, unknown> };
}

export interface IEventBus {
  on<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void;
  off<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void;
  emit<K extends keyof TradingEventMap>(
    event: K,
    data: TradingEventMap[K],
  ): void;
  once<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void;
  removeAllListeners(event?: keyof TradingEventMap): void;
  listenerCount(event: keyof TradingEventMap): number;
}
