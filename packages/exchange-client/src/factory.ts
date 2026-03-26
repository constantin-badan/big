import type { ExchangeConfig } from '@trading-bot/types';
import type { IExchange } from './types';

export function createExchange(config: ExchangeConfig): IExchange {
  switch (config.type) {
    case 'binance-live':
      throw new Error(`Not implemented: ${config.type}`);
    case 'binance-testnet':
      throw new Error(`Not implemented: ${config.type}`);
    case 'backtest-sim':
      throw new Error(`Not implemented: ${config.type}`);
  }
}
