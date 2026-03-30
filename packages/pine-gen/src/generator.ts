/**
 * Pine Script v6 generator from strategy configs.
 *
 * Takes a templateName + scannerParams + pmParams and produces
 * a complete Pine Script strategy that can be pasted into TradingView.
 */

interface StrategyConfig {
  candidateId?: string;
  templateName: string;
  scannerParams: Record<string, number>;
  pmParams: Record<string, number>;
  /** If set, restrict entries to this date range (UTC). */
  dateRange?: { startYear: number; startMonth: number; startDay: number; endYear: number; endMonth: number; endDay: number };
}

// ─── Entry Logic Generators ────────────────────────────────────────

type EntryGenerator = (params: Record<string, number>) => {
  indicators: string;
  longCondition: string;
  shortCondition: string;
};

const entryGenerators: Record<string, EntryGenerator> = {
  'rsi-reversal': (p) => {
    const period = num(p.rsiPeriod, 14);
    const oversold = num(p.oversold, 30);
    const overbought = num(p.overbought, 70);
    return {
      indicators: `rsiVal = ta.rsi(close, ${period})\nprevRsi = ta.rsi(close, ${period})[1]`,
      longCondition: `prevRsi <= ${oversold} and rsiVal > ${oversold}`,
      shortCondition: `prevRsi >= ${overbought} and rsiVal < ${overbought}`,
    };
  },

  'ema-crossover': (p) => {
    const fast = num(p.fastPeriod, 5);
    const slow = num(p.slowPeriod, 20);
    return {
      indicators: `fastEma = ta.ema(close, ${fast})\nslowEma = ta.ema(close, ${slow})\nprevFast = ta.ema(close, ${fast})[1]\nprevSlow = ta.ema(close, ${slow})[1]`,
      longCondition: `prevFast <= prevSlow and fastEma > slowEma`,
      shortCondition: `prevFast >= prevSlow and fastEma < slowEma`,
    };
  },

  'sma-crossover': (p) => {
    const fast = num(p.fastPeriod, 5);
    const slow = num(p.slowPeriod, 20);
    return {
      indicators: `fastSma = ta.sma(close, ${fast})\nslowSma = ta.sma(close, ${slow})\nprevFastSma = ta.sma(close, ${fast})[1]\nprevSlowSma = ta.sma(close, ${slow})[1]`,
      longCondition: `prevFastSma <= prevSlowSma and fastSma > slowSma`,
      shortCondition: `prevFastSma >= prevSlowSma and fastSma < slowSma`,
    };
  },

  'atr-breakout': (p) => {
    const period = num(p.atrPeriod, 14);
    const mult = num(p.atrMultiplier, 2);
    return {
      indicators: `atrVal = ta.atr(${period})\nprevClose = close[1]\nbreakoutThreshold = atrVal * ${flt(mult)}`,
      longCondition: `close > prevClose + breakoutThreshold`,
      shortCondition: `close < prevClose - breakoutThreshold`,
    };
  },

  'rsi-ema-combo': (p) => {
    const emaPeriod = num(p.emaPeriod, 20);
    const rsiPeriod = num(p.rsiPeriod, 14);
    const oversold = num(p.oversold, 30);
    const overbought = num(p.overbought, 70);
    return {
      indicators: `emaVal = ta.ema(close, ${emaPeriod})\nrsiVal = ta.rsi(close, ${rsiPeriod})\nprevRsi = ta.rsi(close, ${rsiPeriod})[1]`,
      longCondition: `close > emaVal and prevRsi <= ${oversold} and rsiVal > ${oversold}`,
      shortCondition: `close < emaVal and prevRsi >= ${overbought} and rsiVal < ${overbought}`,
    };
  },

  'vwap-reversion': (p) => {
    const dev = flt(num(p.deviationPct, 1.5));
    return {
      indicators: `vwapVal = ta.vwap\nvwapDev = ((close - vwapVal) / vwapVal) * 100`,
      longCondition: `vwapDev <= -${dev}`,
      shortCondition: `vwapDev >= ${dev}`,
    };
  },

  'macd-momentum': (p) => {
    const fast = num(p.fastPeriod, 12);
    const slow = num(p.slowPeriod, 26);
    const signal = num(p.signalPeriod, 9);
    return {
      indicators: `[macdLine, signalLine, histogram] = ta.macd(close, ${fast}, ${slow}, ${signal})\nprevHist = histogram[1]`,
      longCondition: `prevHist <= 0 and histogram > 0`,
      shortCondition: `prevHist >= 0 and histogram < 0`,
    };
  },

  'bb-atr-squeeze': (p) => {
    const bbPeriod = num(p.bbPeriod, 20);
    const bbStdDev = flt(num(p.bbStdDev, 2));
    const atrPeriod = num(p.atrPeriod, 10);
    const atrMult = flt(num(p.atrExpansionMult, 1.2));
    return {
      indicators: [
        `[bbMiddle, bbUpper, bbLower] = ta.bb(close, ${bbPeriod}, ${bbStdDev})`,
        `bbPctB = (close - bbLower) / (bbUpper - bbLower)`,
        `prevBbPctB = bbPctB[1]`,
        `atrVal = ta.atr(${atrPeriod})`,
        `prevAtr = atrVal[1]`,
        `atrExpanding = atrVal > prevAtr * ${atrMult}`,
      ].join('\n'),
      longCondition: `prevBbPctB <= 1.0 and bbPctB > 1.0 and atrExpanding`,
      shortCondition: `prevBbPctB >= 0.0 and bbPctB < 0.0 and atrExpanding`,
    };
  },

  'candle-macd': (p) => {
    const count = num(p.consecutiveCount, 3);
    const fast = num(p.fastPeriod, 12);
    const slow = num(p.slowPeriod, 26);
    const signal = num(p.signalPeriod, 9);
    return {
      indicators: [
        `[macdLine, signalLine, histogram] = ta.macd(close, ${fast}, ${slow}, ${signal})`,
        `bullish = close > open`,
        `bearish = close < open`,
        `bullCount = ta.barssince(not bullish)`,
        `bearCount = ta.barssince(not bearish)`,
      ].join('\n'),
      longCondition: `bullCount >= ${count} and histogram > 0`,
      shortCondition: `bearCount >= ${count} and histogram < 0`,
    };
  },

  'atr-vol-breakout': (p) => {
    const atrPeriod = num(p.atrPeriod, 14);
    const atrMult = flt(num(p.atrMultiplier, 2));
    const volPeriod = num(p.volSmaPeriod, 20);
    const volMult = flt(num(p.volMultiplier, 1.5));
    return {
      indicators: [
        `atrVal = ta.atr(${atrPeriod})`,
        `prevClose = close[1]`,
        `volSma = ta.sma(volume, ${volPeriod})`,
        `volSpike = volume > volSma * ${volMult}`,
      ].join('\n'),
      longCondition: `close > prevClose + atrVal * ${atrMult} and volSpike`,
      shortCondition: `close < prevClose - atrVal * ${atrMult} and volSpike`,
    };
  },

  'zscore-reversion': (p) => {
    const period = num(p.smaPeriod, 20);
    const zEntry = flt(num(p.entryZScore, 2));
    return {
      indicators: [
        `smaVal = ta.sma(close, ${period})`,
        `stdDev = ta.stdev(close, ${period})`,
        `zScore = stdDev != 0 ? (close - smaVal) / stdDev : 0`,
      ].join('\n'),
      longCondition: `zScore <= -${zEntry}`,
      shortCondition: `zScore >= ${zEntry}`,
    };
  },

  'keltner-reversion': (p) => {
    const emaPeriod = num(p.emaPeriod, 20);
    const atrPeriod = num(p.atrPeriod, 10);
    const atrMult = flt(num(p.atrMultiplier, 2));
    return {
      indicators: [
        `[kcMiddle, kcUpper, kcLower] = ta.kc(close, ${emaPeriod}, ${atrMult}, true, ${atrPeriod})`,
        `kcPctB = (close - kcLower) / (kcUpper - kcLower)`,
      ].join('\n'),
      longCondition: `kcPctB < 0`,
      shortCondition: `kcPctB > 1`,
    };
  },

  'stochrsi-reversal': (p) => {
    const rsiPeriod = num(p.rsiPeriod, 14);
    const stochPeriod = num(p.stochPeriod, 14);
    const oversold = num(p.oversold, 20);
    const overbought = num(p.overbought, 80);
    return {
      indicators: [
        `rsiVal = ta.rsi(close, ${rsiPeriod})`,
        `stochRsiK = ta.stoch(rsiVal, rsiVal, rsiVal, ${stochPeriod})`,
        `prevStochRsi = stochRsiK[1]`,
      ].join('\n'),
      longCondition: `prevStochRsi <= ${oversold} and stochRsiK > ${oversold}`,
      shortCondition: `prevStochRsi >= ${overbought} and stochRsiK < ${overbought}`,
    };
  },

  'vwap-rsi': (p) => {
    const dev = flt(num(p.deviationPct, 1.5));
    const rsiPeriod = num(p.rsiPeriod, 14);
    const oversold = num(p.oversold, 30);
    const overbought = num(p.overbought, 70);
    return {
      indicators: [
        `vwapVal = ta.vwap`,
        `vwapDev = ((close - vwapVal) / vwapVal) * 100`,
        `rsiVal = ta.rsi(close, ${rsiPeriod})`,
      ].join('\n'),
      longCondition: `vwapDev <= -${dev} and rsiVal <= ${oversold}`,
      shortCondition: `vwapDev >= ${dev} and rsiVal >= ${overbought}`,
    };
  },

  'donchian-vol-breakout': (p) => {
    const period = num(p.donchianPeriod, 20);
    const volPeriod = num(p.volSmaPeriod, 20);
    const volMult = flt(num(p.volMultiplier, 1.5));
    return {
      indicators: [
        `dcUpper = ta.highest(high, ${period})`,
        `dcLower = ta.lowest(low, ${period})`,
        `dcRange = dcUpper - dcLower`,
        `dcPctB = dcRange != 0 ? (close - dcLower) / dcRange : 0.5`,
        `prevDcPctB = dcPctB[1]`,
        `volSma = ta.sma(volume, ${volPeriod})`,
        `volSpike = volume > volSma * ${volMult}`,
      ].join('\n'),
      longCondition: `dcPctB >= 0.95 and prevDcPctB < 0.95 and volSpike`,
      shortCondition: `dcPctB <= 0.05 and prevDcPctB > 0.05 and volSpike`,
    };
  },

  'ema-trend-rsi-entry': (p) => {
    const trendEma = num(p.trendEmaPeriod, 50);
    const rsiPeriod = num(p.entryRsiPeriod, 14);
    const oversold = num(p.entryOversold, 25);
    const overbought = num(p.entryOverbought, 75);
    return {
      indicators: [
        `// Note: multi-timeframe — trend EMA should be on 4h, entry RSI on chart TF`,
        `trendEma = ta.ema(close, ${trendEma})`,
        `rsiVal = ta.rsi(close, ${rsiPeriod})`,
        `prevRsi = rsiVal[1]`,
        `trendBullish = close > trendEma`,
        `trendBearish = close < trendEma`,
      ].join('\n'),
      longCondition: `trendBullish and prevRsi <= ${oversold} and rsiVal > ${oversold}`,
      shortCondition: `trendBearish and prevRsi >= ${overbought} and rsiVal < ${overbought}`,
    };
  },
};

// ─── PM / Exit Logic ───────────────────────────────────────────────

function generateExitLogic(pm: Record<string, number>): string {
  const sl = flt(pm.stopLossPct ?? 2);
  const tp = flt(pm.takeProfitPct ?? 4);
  const holdBars = Math.round((pm.maxHoldTimeHours ?? 4) * 12); // 5m candles per hour
  const trailActivation = pm.trailingActivationPct ?? 0;
  const trailDist = flt(pm.trailingDistancePct ?? 0.5);
  const breakeven = pm.breakevenPct ?? 0;

  const lines: string[] = [];

  // Breakeven SL
  if (breakeven > 0) {
    lines.push(`// Breakeven: move SL to entry after ${flt(breakeven)}% profit`);
    lines.push(`var float beEntryLong = na`);
    lines.push(`var float beEntryShort = na`);
    lines.push(`if strategy.position_size > 0 and na(beEntryLong)`);
    lines.push(`    beEntryLong := strategy.position_avg_price`);
    lines.push(`if strategy.position_size < 0 and na(beEntryShort)`);
    lines.push(`    beEntryShort := strategy.position_avg_price`);
    lines.push(`if strategy.position_size == 0`);
    lines.push(`    beEntryLong := na`);
    lines.push(`    beEntryShort := na`);
    lines.push(``);
    lines.push(`longBePct = strategy.position_size > 0 and not na(beEntryLong) ? (high - beEntryLong) / beEntryLong * 100 : 0.0`);
    lines.push(`shortBePct = strategy.position_size < 0 and not na(beEntryShort) ? (beEntryShort - low) / beEntryShort * 100 : 0.0`);
    lines.push(`longBeActive = longBePct >= ${flt(breakeven)}`);
    lines.push(`shortBeActive = shortBePct >= ${flt(breakeven)}`);
    lines.push(``);
    lines.push(`longSlPct = longBeActive ? 0.01 : ${sl}  // 0.01% = effectively at entry`);
    lines.push(`shortSlPct = shortBeActive ? 0.01 : ${sl}`);
  }

  const slVar = breakeven > 0 ? 'longSlPct' : sl;
  const slVarShort = breakeven > 0 ? 'shortSlPct' : sl;

  lines.push(``);
  lines.push(`// Exit: SL/TP`);
  lines.push(`strategy.exit("Long Exit", "Long", profit=close * ${tp} / 100 / syminfo.mintick, loss=close * ${slVar} / 100 / syminfo.mintick)`);
  lines.push(`strategy.exit("Short Exit", "Short", profit=close * ${tp} / 100 / syminfo.mintick, loss=close * ${slVarShort} / 100 / syminfo.mintick)`);

  // Trailing stop
  if (trailActivation > 0) {
    lines.push(``);
    lines.push(`// Trailing stop: activates at ${flt(trailActivation)}%, trails at ${trailDist}%`);
    lines.push(`strategy.exit("Long Trail", "Long", trail_price=strategy.position_avg_price * (1 + ${flt(trailActivation)} / 100), trail_offset=close * ${trailDist} / 100 / syminfo.mintick)`);
    lines.push(`strategy.exit("Short Trail", "Short", trail_price=strategy.position_avg_price * (1 - ${flt(trailActivation)} / 100), trail_offset=close * ${trailDist} / 100 / syminfo.mintick)`);
  }

  // Timeout
  if (holdBars > 0) {
    lines.push(``);
    lines.push(`// Timeout: close after ${String(holdBars)} bars (~${String(pm.maxHoldTimeHours ?? 4)}h on 5m)`);
    lines.push(`if strategy.position_size != 0 and bar_index - strategy.opentrades.entry_bar_index(0) >= ${String(holdBars)}`);
    lines.push(`    strategy.close_all("Timeout")`);
  }

  return lines.join('\n');
}

// ─── Main Generator ────────────────────────────────────────────────

export function generatePineScript(config: StrategyConfig): string {
  const { templateName, scannerParams, pmParams, candidateId } = config;

  const generator = entryGenerators[templateName];
  if (!generator) {
    throw new Error(`No Pine generator for template: ${templateName}. Supported: ${Object.keys(entryGenerators).join(', ')}`);
  }

  const entry = generator(scannerParams);
  const exit = generateExitLogic(pmParams);

  const label = candidateId ?? `${templateName}-custom`;
  const sl = flt(pmParams.stopLossPct ?? 2);
  const tp = flt(pmParams.takeProfitPct ?? 4);
  const dr = config.dateRange;

  const dateFilter = dr
    ? `\n// ─── Date Range Filter ─────────────────────────────────────────\ninDateRange = time >= timestamp(${String(dr.startYear)}, ${String(dr.startMonth)}, ${String(dr.startDay)}, 0, 0) and time < timestamp(${String(dr.endYear)}, ${String(dr.endMonth)}, ${String(dr.endDay)}, 0, 0)\n`
    : '';

  const entryGuard = dr ? 'inDateRange and ' : '';
  const dateClose = dr
    ? `\n// Close all positions when exiting date range\nif not inDateRange and strategy.position_size != 0\n    strategy.close_all("Date Range End")\n`
    : '';

  return `//@version=6
strategy("${label}", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=5, commission_type=strategy.commission.percent, commission_value=0.04, slippage=1, initial_capital=10000)

// ─── Indicators ────────────────────────────────────────────────
${entry.indicators}
${dateFilter}
// ─── Entry Conditions ──────────────────────────────────────────
longCond = ${entry.longCondition}
shortCond = ${entry.shortCondition}

// ─── Execute Entries ───────────────────────────────────────────
if ${entryGuard}longCond
    strategy.entry("Long", strategy.long)
if ${entryGuard}shortCond
    strategy.entry("Short", strategy.short)

// ─── Exit Logic (SL=${sl}% TP=${tp}%) ──────────────────────────
${exit}
${dateClose}
// ─── Plot ──────────────────────────────────────────────────────
plotshape(${entryGuard}longCond, "Long Signal", shape.triangleup, location.belowbar, color.green, size=size.small)
plotshape(${entryGuard}shortCond, "Short Signal", shape.triangledown, location.abovebar, color.red, size=size.small)
`;
}

// ─── Batch: generate from robust.json format ───────────────────

interface RobustEntry {
  candidateId: string;
  templateName: string;
  scannerParams: Record<string, number>;
  pmParams: Record<string, number>;
}

interface RobustJson {
  robust: RobustEntry[];
}

/** Reinterpret unknown JSON as typed value without `as` assertion. */
function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

export async function generateFromFile(inputPath: string, outputDir: string): Promise<string[]> {
  const data = unsafeCast<RobustJson>(await Bun.file(inputPath).json());

  const written: string[] = [];
  for (const entry of data.robust) {
    const pine = generatePineScript(entry);
    const filename = `${entry.candidateId}.pine`;
    const outPath = `${outputDir}/${filename}`;
    await Bun.write(outPath, pine);
    written.push(outPath);
  }

  return written;
}

// ─── Helpers ───────────────────────────────────────────────────

function num(v: number | undefined, fallback: number): number {
  return v ?? fallback;
}

function flt(v: number): string {
  return Number.isInteger(v) ? `${String(v)}.0` : String(v);
}
