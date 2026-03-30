export { emaCrossover, createEmaCrossoverFactory } from './ema-crossover';
export { rsiReversal } from './rsi-reversal';
export { atrBreakout } from './atr-breakout';
export { smaCrossover } from './sma-crossover';
export { rsiEmaCombo } from './rsi-ema-combo';
export { vwapReversion } from './vwap-reversion';

import type { ScannerTemplate } from '@trading-bot/types';
import { emaCrossover } from './ema-crossover';
import { rsiReversal } from './rsi-reversal';
import { atrBreakout } from './atr-breakout';
import { smaCrossover } from './sma-crossover';
import { rsiEmaCombo } from './rsi-ema-combo';
import { vwapReversion } from './vwap-reversion';

/** Registry of all available scanner templates. */
export const TEMPLATES: readonly ScannerTemplate[] = [
  emaCrossover,
  rsiReversal,
  atrBreakout,
  smaCrossover,
  rsiEmaCombo,
  vwapReversion,
];
