import { Database } from 'bun:sqlite';

import type { Candle, Symbol, Timeframe, TradeRecord } from '@trading-bot/types';
import { toSymbol } from '@trading-bot/types';

import type { ICandleStore, ITradeStore, TradeFilter } from './types';
import { jsonParse, unsafeCast } from './unsafe-cast';

const CANDLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  close_time INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  quote_volume REAL NOT NULL,
  trades INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time)
)`;

const TRADE_SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  quantity REAL NOT NULL,
  entry_time INTEGER NOT NULL,
  exit_time INTEGER NOT NULL,
  pnl REAL NOT NULL,
  fees REAL NOT NULL,
  slippage REAL NOT NULL,
  hold_time_ms INTEGER NOT NULL,
  exit_reason TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
)`;

const TRADE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_name, exit_time)',
  'CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol, exit_time)',
];

// Timeframe durations in ms — used for gap detection
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

class CandleStore implements ICandleStore {
  private readonly db: Database;
  private readonly insertStmt: ReturnType<Database['prepare']>;
  private readonly selectStmt: ReturnType<Database['prepare']>;
  private readonly earliestStmt: ReturnType<Database['prepare']>;
  private readonly latestStmt: ReturnType<Database['prepare']>;
  private readonly gapStmt: ReturnType<Database['prepare']>;

  constructor(db: Database) {
    this.db = db;

    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO candles
      (symbol, timeframe, open_time, close_time, open, high, low, close, volume, quote_volume, trades)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.selectStmt = db.prepare(`
      SELECT open_time, close_time, open, high, low, close, volume, quote_volume, trades
      FROM candles
      WHERE symbol = ? AND timeframe = ? AND open_time >= ? AND open_time <= ?
      ORDER BY open_time ASC
    `);

    this.earliestStmt = db.prepare(`
      SELECT MIN(open_time) as earliest
      FROM candles
      WHERE symbol = ? AND timeframe = ?
    `);

    this.latestStmt = db.prepare(`
      SELECT MAX(open_time) as latest
      FROM candles
      WHERE symbol = ? AND timeframe = ?
    `);

    this.gapStmt = db.prepare(`
      SELECT open_time
      FROM candles
      WHERE symbol = ? AND timeframe = ?
      ORDER BY open_time ASC
    `);
  }

  insertCandles(symbol: Symbol, timeframe: Timeframe, candles: Candle[]): void {
    const insert = this.db.transaction(() => {
      for (const c of candles) {
        this.insertStmt.run(
          symbol,
          timeframe,
          c.openTime,
          c.closeTime,
          c.open,
          c.high,
          c.low,
          c.close,
          c.volume,
          c.quoteVolume,
          c.trades,
        );
      }
    });
    insert();
  }

  getCandles(symbol: Symbol, timeframe: Timeframe, startTime: number, endTime: number): Candle[] {
    interface CandleRow {
      open_time: number;
      close_time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      quote_volume: number;
      trades: number;
    }

    const rows = unsafeCast<CandleRow[]>(
      this.selectStmt.all(symbol, timeframe, startTime, endTime),
    );
    return rows.map(
      (r): Candle => ({
        symbol,
        openTime: r.open_time,
        closeTime: r.close_time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        quoteVolume: r.quote_volume,
        trades: r.trades,
        isClosed: true,
      }),
    );
  }

  getEarliestTimestamp(symbol: Symbol, timeframe: Timeframe): number | null {
    interface EarliestRow {
      earliest: number | null;
    }
    const row = unsafeCast<EarliestRow | null>(this.earliestStmt.get(symbol, timeframe));
    return row?.earliest ?? null;
  }

  getLatestTimestamp(symbol: Symbol, timeframe: Timeframe): number | null {
    interface LatestRow {
      latest: number | null;
    }
    const row = unsafeCast<LatestRow | null>(this.latestStmt.get(symbol, timeframe));
    return row?.latest ?? null;
  }

  getGaps(symbol: Symbol, timeframe: Timeframe): Array<{ from: number; to: number }> {
    interface TimeRow {
      open_time: number;
    }
    const rows = unsafeCast<TimeRow[]>(this.gapStmt.all(symbol, timeframe));
    const intervalMs = TIMEFRAME_MS[timeframe];
    if (intervalMs === undefined || rows.length < 2) return [];

    const gaps: Array<{ from: number; to: number }> = [];
    for (let i = 0; i < rows.length - 1; i++) {
      const current = rows[i]!.open_time;
      const next = rows[i + 1]!.open_time;
      const expected = current + intervalMs;
      if (next > expected) {
        gaps.push({ from: current, to: next });
      }
    }
    return gaps;
  }
}

class TradeStore implements ITradeStore {
  private readonly insertStmt: ReturnType<Database['prepare']>;
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;

    this.insertStmt = db.prepare(`
      INSERT INTO trades
      (id, strategy_name, symbol, side, entry_price, exit_price, quantity,
       entry_time, exit_time, pnl, fees, slippage, hold_time_ms, exit_reason, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  insertTrade(strategyName: string, trade: TradeRecord): void {
    this.insertStmt.run(
      trade.id,
      strategyName,
      trade.symbol,
      trade.side,
      trade.entryPrice,
      trade.exitPrice,
      trade.quantity,
      trade.entryTime,
      trade.exitTime,
      trade.pnl,
      trade.fees,
      trade.slippage,
      trade.holdTimeMs,
      trade.exitReason,
      JSON.stringify(trade.metadata),
      Date.now(),
    );
  }

  getTrades(filter: TradeFilter): TradeRecord[] {
    interface TradeRow {
      id: string;
      symbol: string;
      side: string;
      entry_price: number;
      exit_price: number;
      quantity: number;
      entry_time: number;
      exit_time: number;
      pnl: number;
      fees: number;
      slippage: number;
      hold_time_ms: number;
      exit_reason: string;
      metadata: string | null;
    }

    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (filter.strategyName !== undefined) {
      conditions.push('strategy_name = ?');
      params.push(filter.strategyName);
    }
    if (filter.symbol !== undefined) {
      conditions.push('symbol = ?');
      params.push(filter.symbol);
    }
    if (filter.startTime !== undefined) {
      conditions.push('exit_time >= ?');
      params.push(filter.startTime);
    }
    if (filter.endTime !== undefined) {
      conditions.push('exit_time <= ?');
      params.push(filter.endTime);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT id, symbol, side, entry_price, exit_price, quantity, entry_time, exit_time, pnl, fees, slippage, hold_time_ms, exit_reason, metadata FROM trades ${where} ORDER BY exit_time ASC`;

    const stmt = this.db.prepare(sql);
    const rows = unsafeCast<TradeRow[]>(stmt.all(...params));

    return rows.map((r): TradeRecord => {
      if (r.side !== 'LONG' && r.side !== 'SHORT') {
        throw new Error(`Invalid side value in trade record: '${r.side}'`);
      }
      const side: TradeRecord['side'] = r.side;
      const exitReason: TradeRecord['exitReason'] = unsafeCast<TradeRecord['exitReason']>(
        r.exit_reason,
      );
      const metadata: Record<string, unknown> = r.metadata
        ? jsonParse<Record<string, unknown>>(r.metadata)
        : {};
      return {
        id: r.id,
        symbol: toSymbol(r.symbol),
        side,
        entryPrice: r.entry_price,
        exitPrice: r.exit_price,
        quantity: r.quantity,
        entryTime: r.entry_time,
        exitTime: r.exit_time,
        pnl: r.pnl,
        fees: r.fees,
        slippage: r.slippage,
        holdTimeMs: r.hold_time_ms,
        exitReason,
        metadata,
      };
    });
  }
}

export function createStorage(dbPath: string): {
  candles: ICandleStore;
  trades: ITradeStore;
  close: () => void;
} {
  const db = new Database(dbPath);

  // Enable WAL mode for concurrent read performance
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');

  // Create tables
  db.run(CANDLE_SCHEMA);
  db.run(TRADE_SCHEMA);
  for (const idx of TRADE_INDEXES) {
    db.run(idx);
  }

  return {
    candles: new CandleStore(db),
    trades: new TradeStore(db),
    close: () => db.close(),
  };
}
