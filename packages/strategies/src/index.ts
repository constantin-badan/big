export { emaCrossover, createEmaCrossoverFactory } from './ema-crossover';
export { rsiReversal } from './rsi-reversal';
export { atrBreakout } from './atr-breakout';
export { smaCrossover } from './sma-crossover';
export { rsiEmaCombo } from './rsi-ema-combo';
export { vwapReversion } from './vwap-reversion';
export { emaTrendRsiEntry } from './ema-trend-rsi-entry';
export { atrVolBreakout } from './atr-vol-breakout';
export { macdMomentum } from './macd-momentum';
export { bbAtrSqueeze } from './bb-atr-squeeze';
export { candleMacd } from './candle-macd';
export { zscoreReversion } from './zscore-reversion';
export { keltnerReversion } from './keltner-reversion';
export { stochrsiReversal } from './stochrsi-reversal';
export { vwapRsi } from './vwap-rsi';
export { donchianVolBreakout } from './donchian-vol-breakout';
export { macdRsi } from './macd-rsi';
export { bbBounce } from './bb-bounce';
export { kbSqueeze } from './kb-squeeze';
export { rsiStochrsi } from './rsi-stochrsi';
export { volSpikeReversal } from './vol-spike-reversal';

import type { ScannerTemplate } from '@trading-bot/types';
import { emaCrossover } from './ema-crossover';
import { rsiReversal } from './rsi-reversal';
import { atrBreakout } from './atr-breakout';
import { smaCrossover } from './sma-crossover';
import { rsiEmaCombo } from './rsi-ema-combo';
import { vwapReversion } from './vwap-reversion';
import { emaTrendRsiEntry } from './ema-trend-rsi-entry';
import { atrVolBreakout } from './atr-vol-breakout';
import { macdMomentum } from './macd-momentum';
import { bbAtrSqueeze } from './bb-atr-squeeze';
import { candleMacd } from './candle-macd';
import { zscoreReversion } from './zscore-reversion';
import { keltnerReversion } from './keltner-reversion';
import { stochrsiReversal } from './stochrsi-reversal';
import { vwapRsi } from './vwap-rsi';
import { donchianVolBreakout } from './donchian-vol-breakout';
import { macdRsi } from './macd-rsi';
import { bbBounce } from './bb-bounce';
import { kbSqueeze } from './kb-squeeze';
import { rsiStochrsi } from './rsi-stochrsi';
import { volSpikeReversal } from './vol-spike-reversal';

/** Registry of all available scanner templates. */
export const TEMPLATES: readonly ScannerTemplate[] = [
  emaCrossover,
  rsiReversal,
  atrBreakout,
  smaCrossover,
  rsiEmaCombo,
  vwapReversion,
  emaTrendRsiEntry,
  atrVolBreakout,
  macdMomentum,
  bbAtrSqueeze,
  candleMacd,
  zscoreReversion,
  keltnerReversion,
  stochrsiReversal,
  vwapRsi,
  donchianVolBreakout,
  macdRsi,
  bbBounce,
  kbSqueeze,
  rsiStochrsi,
  volSpikeReversal,
];
