import { describe, test, expect } from 'bun:test';
import { generatePineScript } from '../generator';

describe('generatePineScript', () => {
  test('generates valid Pine for rsi-reversal', () => {
    const pine = generatePineScript({
      candidateId: 'rsi-reversal-407',
      templateName: 'rsi-reversal',
      scannerParams: { rsiPeriod: 8, oversold: 15, overbought: 68 },
      pmParams: { stopLossPct: 3.5, takeProfitPct: 8.5, maxHoldTimeHours: 14 },
    });

    expect(pine).toContain('//@version=6');
    expect(pine).toContain('strategy("rsi-reversal-407"');
    expect(pine).toContain('ta.rsi(close, 8)');
    expect(pine).toContain('<= 15 and rsiVal > 15');
    expect(pine).toContain('>= 68 and rsiVal < 68');
    expect(pine).toContain('strategy.entry("Long", strategy.long)');
    expect(pine).toContain('strategy.entry("Short", strategy.short)');
    expect(pine).toContain('strategy.exit');
    // Without dateRange, no date filter
    expect(pine).not.toContain('inDateRange');
  });

  test('generates valid Pine for ema-crossover', () => {
    const pine = generatePineScript({
      templateName: 'ema-crossover',
      scannerParams: { fastPeriod: 5, slowPeriod: 20 },
      pmParams: { stopLossPct: 2, takeProfitPct: 4, maxHoldTimeHours: 6 },
    });

    expect(pine).toContain('ta.ema(close, 5)');
    expect(pine).toContain('ta.ema(close, 20)');
    expect(pine).toContain('fastEma > slowEma');
  });

  test('includes trailing stop when configured', () => {
    const pine = generatePineScript({
      templateName: 'rsi-reversal',
      scannerParams: { rsiPeriod: 14 },
      pmParams: { stopLossPct: 2, takeProfitPct: 5, maxHoldTimeHours: 8, trailingActivationPct: 1.5, trailingDistancePct: 0.5 },
    });

    expect(pine).toContain('Trailing stop');
    expect(pine).toContain('trail_price');
    expect(pine).toContain('trail_offset');
  });

  test('includes breakeven when configured', () => {
    const pine = generatePineScript({
      templateName: 'rsi-reversal',
      scannerParams: { rsiPeriod: 14 },
      pmParams: { stopLossPct: 2, takeProfitPct: 5, maxHoldTimeHours: 8, breakevenPct: 1.0 },
    });

    expect(pine).toContain('Breakeven');
    expect(pine).toContain('beEntryLong');
    expect(pine).toContain('longBeActive');
    expect(pine).not.toContain('var float longEntry');
    expect(pine).not.toContain('var float shortEntry');
  });

  test('no variable name collisions with breakeven + all features', () => {
    const pine = generatePineScript({
      templateName: 'rsi-reversal',
      scannerParams: { rsiPeriod: 14, oversold: 25, overbought: 75 },
      pmParams: {
        stopLossPct: 2, takeProfitPct: 5, maxHoldTimeHours: 8,
        breakevenPct: 1.0, trailingActivationPct: 1.5, trailingDistancePct: 0.5,
      },
    });

    // longCond is the entry condition variable
    expect(pine).toContain('longCond =');
    expect(pine).toContain('shortCond =');

    // No float variable name collisions
    expect(pine).not.toContain('var float longEntry');
    expect(pine).not.toContain('var float shortEntry');

    // Breakeven uses beEntryLong/beEntryShort
    expect(pine).toContain('var float beEntryLong');
    expect(pine).toContain('var float beEntryShort');

    // All features present
    expect(pine).toContain('Breakeven');
    expect(pine).toContain('Trailing stop');
    expect(pine).toContain('Timeout');
  });

  test('includes timeout', () => {
    const pine = generatePineScript({
      templateName: 'macd-momentum',
      scannerParams: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      pmParams: { stopLossPct: 2, takeProfitPct: 5, maxHoldTimeHours: 4 },
    });

    expect(pine).toContain('Timeout');
    expect(pine).toContain('strategy.close_all("Timeout")');
    expect(pine).toContain('ta.macd');
  });

  test('adds date range filter when dateRange is set', () => {
    const pine = generatePineScript({
      templateName: 'rsi-reversal',
      scannerParams: { rsiPeriod: 14 },
      pmParams: { stopLossPct: 2, takeProfitPct: 5, maxHoldTimeHours: 8 },
      dateRange: { startYear: 2026, startMonth: 1, startDay: 1, endYear: 2026, endMonth: 2, endDay: 1 },
    });

    // Date range filter present
    expect(pine).toContain('inDateRange = time >= timestamp(2026, 1, 1, 0, 0) and time < timestamp(2026, 2, 1, 0, 0)');

    // Entries guarded by date range
    expect(pine).toContain('if inDateRange and longCond');
    expect(pine).toContain('if inDateRange and shortCond');

    // Close positions at end of date range
    expect(pine).toContain('strategy.close_all("Date Range End")');

    // Plots also guarded
    expect(pine).toContain('plotshape(inDateRange and longCond');
  });

  test('throws for unknown template', () => {
    expect(() => generatePineScript({
      templateName: 'nonexistent',
      scannerParams: {},
      pmParams: {},
    })).toThrow('No Pine generator for template: nonexistent');
  });

  test('generates all 16 templates without error', () => {
    const templates = [
      'rsi-reversal', 'ema-crossover', 'sma-crossover', 'atr-breakout',
      'rsi-ema-combo', 'vwap-reversion', 'macd-momentum', 'bb-atr-squeeze',
      'candle-macd', 'atr-vol-breakout', 'zscore-reversion', 'keltner-reversion',
      'stochrsi-reversal', 'vwap-rsi', 'donchian-vol-breakout', 'ema-trend-rsi-entry',
    ];

    for (const name of templates) {
      const pine = generatePineScript({
        templateName: name,
        scannerParams: {},
        pmParams: { stopLossPct: 2, takeProfitPct: 5, maxHoldTimeHours: 8 },
      });
      expect(pine).toContain('//@version=6');
      expect(pine).toContain('strategy.entry');
    }
  });
});
