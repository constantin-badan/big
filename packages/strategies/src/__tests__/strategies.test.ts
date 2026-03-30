import { describe, expect, it } from 'bun:test';
import {
  emaCrossover, rsiReversal, atrBreakout, smaCrossover, rsiEmaCombo, vwapReversion,
  emaTrendRsiEntry, atrVolBreakout, macdMomentum, bbAtrSqueeze, candleMacd, TEMPLATES,
} from '../index';

describe('strategies', () => {
  it('exports all 11 templates', () => {
    expect(emaCrossover.name).toBe('ema-crossover');
    expect(rsiReversal.name).toBe('rsi-reversal');
    expect(atrBreakout.name).toBe('atr-breakout');
    expect(smaCrossover.name).toBe('sma-crossover');
    expect(rsiEmaCombo.name).toBe('rsi-ema-combo');
    expect(vwapReversion.name).toBe('vwap-reversion');
    expect(emaTrendRsiEntry.name).toBe('ema-trend-rsi-entry');
    expect(atrVolBreakout.name).toBe('atr-vol-breakout');
    expect(macdMomentum.name).toBe('macd-momentum');
    expect(bbAtrSqueeze.name).toBe('bb-atr-squeeze');
    expect(candleMacd.name).toBe('candle-macd');
  });

  it('every template has params and createFactory', () => {
    for (const t of TEMPLATES) {
      expect(Object.keys(t.params).length).toBeGreaterThan(0);
      expect(t.createFactory).toBeInstanceOf(Function);
    }
  });

  it('TEMPLATES registry contains all 11 templates', () => {
    expect(TEMPLATES).toHaveLength(11);
    expect(TEMPLATES.map((t) => t.name)).toEqual([
      'ema-crossover', 'rsi-reversal', 'atr-breakout',
      'sma-crossover', 'rsi-ema-combo', 'vwap-reversion',
      'ema-trend-rsi-entry', 'atr-vol-breakout', 'macd-momentum',
      'bb-atr-squeeze', 'candle-macd',
    ]);
  });

  it('emaCrossover.isValid rejects fast >= slow', () => {
    expect(emaCrossover.isValid!({ fastPeriod: 20, slowPeriod: 10 })).toBe(false);
    expect(emaCrossover.isValid!({ fastPeriod: 5, slowPeriod: 20 })).toBe(true);
  });

  it('smaCrossover.isValid rejects fast >= slow', () => {
    expect(smaCrossover.isValid!({ fastPeriod: 20, slowPeriod: 10 })).toBe(false);
    expect(smaCrossover.isValid!({ fastPeriod: 5, slowPeriod: 20 })).toBe(true);
  });

  it('rsiReversal.isValid rejects oversold >= overbought', () => {
    expect(rsiReversal.isValid!({ oversold: 70, overbought: 30 })).toBe(false);
    expect(rsiReversal.isValid!({ oversold: 30, overbought: 70 })).toBe(true);
  });

  it('rsiEmaCombo.isValid rejects oversold >= overbought', () => {
    expect(rsiEmaCombo.isValid!({ oversold: 70, overbought: 30 })).toBe(false);
    expect(rsiEmaCombo.isValid!({ oversold: 25, overbought: 75 })).toBe(true);
  });

  it('emaTrendRsiEntry.isValid rejects oversold >= overbought', () => {
    expect(emaTrendRsiEntry.isValid!({ entryOversold: 70, entryOverbought: 30 })).toBe(false);
    expect(emaTrendRsiEntry.isValid!({ entryOversold: 25, entryOverbought: 75 })).toBe(true);
  });

  it('macdMomentum.isValid rejects fast >= slow', () => {
    expect(macdMomentum.isValid!({ fastPeriod: 20, slowPeriod: 10 })).toBe(false);
    expect(macdMomentum.isValid!({ fastPeriod: 8, slowPeriod: 26 })).toBe(true);
  });

  it('candleMacd.isValid rejects fast >= slow', () => {
    expect(candleMacd.isValid!({ fastPeriod: 20, slowPeriod: 10 })).toBe(false);
    expect(candleMacd.isValid!({ fastPeriod: 8, slowPeriod: 26 })).toBe(true);
  });

  it('emaTrendRsiEntry declares requiredTimeframes', () => {
    expect(emaTrendRsiEntry.requiredTimeframes).toEqual(['4h']);
  });
});
