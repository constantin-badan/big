import type {
  Candle,
  OrderResult,
  Position,
  PositionManagerConfig,
  RiskConfig,
  Signal,
  Tick,
} from '@trading-bot/types';

const BASE_TIME = 1700000000000;

function makeCandle(index: number): Candle {
  const open = 50000 + index * 10;
  return {
    openTime: BASE_TIME + index * 60000,
    closeTime: BASE_TIME + (index + 1) * 60000 - 1,
    open,
    high: open + 50,
    low: open - 30,
    close: open + 20,
    volume: 100 + index,
    quoteVolume: (100 + index) * open,
    trades: 50 + index,
    isClosed: true,
  };
}

const candles: Candle[] = Array.from({ length: 100 }, (_, i) => makeCandle(i));

const candle: Candle = candles[0]!;

const tick: Tick = {
  symbol: 'BTCUSDT',
  price: 50000,
  quantity: 0.5,
  timestamp: BASE_TIME,
  isBuyerMaker: false,
};

const longSignal: Signal = {
  symbol: 'BTCUSDT',
  action: 'ENTER_LONG',
  confidence: 0.85,
  price: 50020,
  timestamp: BASE_TIME,
  sourceScanner: 'test-scanner',
  metadata: {},
};

const shortSignal: Signal = {
  symbol: 'BTCUSDT',
  action: 'ENTER_SHORT',
  confidence: 0.75,
  price: 50020,
  timestamp: BASE_TIME,
  sourceScanner: 'test-scanner',
  metadata: {},
};

const exitSignal: Signal = {
  symbol: 'BTCUSDT',
  action: 'EXIT',
  confidence: 1.0,
  price: 50020,
  timestamp: BASE_TIME,
  sourceScanner: 'test-scanner',
  metadata: {},
};

const filledBuy: OrderResult = {
  orderId: 'order-1',
  clientOrderId: 'client-1',
  symbol: 'BTCUSDT',
  side: 'BUY',
  type: 'MARKET',
  status: 'FILLED',
  price: 50000,
  avgPrice: 50010,
  quantity: 0.1,
  filledQuantity: 0.1,
  commission: 2.0,
  commissionAsset: 'USDT',
  timestamp: BASE_TIME,
  latencyMs: 50,
};

const filledSell: OrderResult = {
  orderId: 'order-2',
  clientOrderId: 'client-2',
  symbol: 'BTCUSDT',
  side: 'SELL',
  type: 'MARKET',
  status: 'FILLED',
  price: 51000,
  avgPrice: 50990,
  quantity: 0.1,
  filledQuantity: 0.1,
  commission: 2.04,
  commissionAsset: 'USDT',
  timestamp: BASE_TIME + 3600000,
  latencyMs: 45,
};

const rejectedOrder: OrderResult = {
  orderId: 'order-3',
  clientOrderId: 'client-3',
  symbol: 'BTCUSDT',
  side: 'BUY',
  type: 'LIMIT',
  status: 'REJECTED',
  price: 49000,
  avgPrice: 0,
  quantity: 0.1,
  filledQuantity: 0,
  commission: 0,
  commissionAsset: 'USDT',
  timestamp: BASE_TIME,
  latencyMs: 30,
};

const openLong: Position = {
  symbol: 'BTCUSDT',
  side: 'LONG',
  entryPrice: 50000,
  quantity: 0.1,
  unrealizedPnl: 100,
  leverage: 10,
  liquidationPrice: 45000,
  marginType: 'ISOLATED',
  timestamp: BASE_TIME,
};

const defaultRiskConfig: RiskConfig = {
  maxPositionSizePct: 5,
  maxConcurrentPositions: 3,
  maxDailyLossPct: 2,
  maxDrawdownPct: 10,
  maxDailyTrades: 20,
  cooldownAfterLossMs: 60000,
  leverage: 1,
  initialBalance: 10000,
};

const defaultPositionManagerConfig: PositionManagerConfig = {
  defaultStopLossPct: 2,
  defaultTakeProfitPct: 4,
  trailingStopEnabled: false,
  trailingStopActivationPct: 1.5,
  trailingStopDistancePct: 0.5,
  maxHoldTimeMs: 3600000,
};

export const fixtures = {
  candles,
  candle,
  tick,
  longSignal,
  shortSignal,
  exitSignal,
  filledBuy,
  filledSell,
  rejectedOrder,
  openLong,
  defaultRiskConfig,
  defaultPositionManagerConfig,
};
