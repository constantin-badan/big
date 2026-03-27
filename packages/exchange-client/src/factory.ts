import type { ExchangeConfig } from '@trading-bot/types';

import { BinanceAdapter } from './binance/adapter';
import type { IExchange } from './types';

export function createExchange(config: ExchangeConfig): IExchange {
  switch (config.type) {
    case 'binance-live':
      return new BinanceAdapter(config);
    case 'binance-testnet':
      return new BinanceAdapter(config);
    case 'backtest-sim':
      throw new Error(`Not implemented: ${config.type}`);
  }
}
