"""
Parity check: RSI reversal strategy using backtesting.py

Matches the exact config from rsi-reversal-391:
  RSI period: 13, oversold: 26, overbought: 74
  SL: 1.5%, TP: 9.5%, timeout: 18h (216 bars on 5m)
  Capital: $10,000, Position: 5% of equity
  Fees: 0.04% (taker), Slippage: 5 bps

Usage:
  pip install backtesting pandas
  python scripts/parity-check.py

Loads the same BTCUSDT 5m candle data from our SQLite DB.
"""
import sqlite3
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from backtesting import Backtest, Strategy
from backtesting.lib import crossover

DB_PATH = "./data/candles.db"
SYMBOL = "BTCUSDT"
TIMEFRAME = "5m"

# Parity period: last 4 complete days (matches our parity.ts)
today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
PARITY_END = today
PARITY_START = today - pd.Timedelta(days=4)

# 1 day warmup (matches our parity.ts)
WARMUP_START = PARITY_START - pd.Timedelta(days=1)

# Strategy params (rsi-reversal-391)
RSI_PERIOD = 13
OVERSOLD = 21
OVERBOUGHT = 68
SL_PCT = 1.5   # stop loss %
TP_PCT = 9.5   # take profit %
TIMEOUT_BARS = 216  # 18h * 12 bars/h

def load_candles():
    """Load candles from our SQLite DB."""
    conn = sqlite3.connect(DB_PATH)

    start_ms = int(WARMUP_START.timestamp() * 1000)
    end_ms = int(PARITY_END.timestamp() * 1000)

    query = """
        SELECT open_time, open, high, low, close, volume
        FROM candles
        WHERE symbol = ? AND timeframe = ?
        AND open_time >= ? AND open_time < ?
        ORDER BY open_time ASC
    """

    df = pd.read_sql_query(query, conn, params=(SYMBOL, TIMEFRAME, start_ms, end_ms))
    conn.close()

    if df.empty:
        raise ValueError(f"No candles found for {SYMBOL} {TIMEFRAME} in DB. Run sync first.")

    # Convert to backtesting.py format
    df['Date'] = pd.to_datetime(df['open_time'], unit='ms', utc=True)
    df = df.set_index('Date')
    df = df.rename(columns={
        'open': 'Open',
        'high': 'High',
        'low': 'Low',
        'close': 'Close',
        'volume': 'Volume',
    })
    df = df[['Open', 'High', 'Low', 'Close', 'Volume']]

    return df


def wilder_rsi(close, period):
    """Compute RSI using Wilder's smoothing (same as our engine and TV)."""
    close = pd.Series(close)
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)

    # First average: SMA
    avg_gain = gain.rolling(window=period).mean()
    avg_loss = loss.rolling(window=period).mean()

    # Wilder's smoothing for subsequent values
    for i in range(period, len(close)):
        if i == period:
            continue  # first value is SMA, already set
        avg_gain.iloc[i] = (avg_gain.iloc[i-1] * (period - 1) + gain.iloc[i]) / period
        avg_loss.iloc[i] = (avg_loss.iloc[i-1] * (period - 1) + loss.iloc[i]) / period

    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    rsi = rsi.where(avg_loss != 0, 100)

    return rsi


class RsiReversal(Strategy):
    rsi_period = RSI_PERIOD
    oversold = OVERSOLD
    overbought = OVERBOUGHT
    sl_pct = SL_PCT
    tp_pct = TP_PCT
    timeout_bars = TIMEOUT_BARS

    def init(self):
        self.rsi = self.I(wilder_rsi, self.data.Close, self.rsi_period)
        self.entry_bar = None

    def next(self):
        # Skip candles before parity period
        current_time = self.data.index[-1]
        if current_time < PARITY_START or current_time >= PARITY_END:
            if self.position:
                self.position.close()
            return

        rsi = self.rsi[-1]
        prev_rsi = self.rsi[-2] if len(self.rsi) > 1 else None

        if prev_rsi is None or np.isnan(prev_rsi) or np.isnan(rsi):
            return

        # Timeout check
        if self.position and self.entry_bar is not None:
            bars_held = len(self.data) - self.entry_bar
            if bars_held >= self.timeout_bars:
                self.position.close()
                self.entry_bar = None
                return

        # Only enter when flat
        if not self.position:
            # LONG: RSI crosses above oversold
            if prev_rsi <= self.oversold and rsi > self.oversold:
                self.buy(
                    size=0.05,  # 5% of equity
                    sl=self.data.Close[-1] * (1 - self.sl_pct / 100),
                    tp=self.data.Close[-1] * (1 + self.tp_pct / 100),
                )
                self.entry_bar = len(self.data)

            # SHORT: RSI crosses below overbought
            elif prev_rsi >= self.overbought and rsi < self.overbought:
                self.sell(
                    size=0.05,  # 5% of equity
                    sl=self.data.Close[-1] * (1 + self.sl_pct / 100),
                    tp=self.data.Close[-1] * (1 - self.tp_pct / 100),
                )
                self.entry_bar = len(self.data)


def main():
    print(f"=== Parity Check: backtesting.py ===")
    print(f"Symbol: {SYMBOL}, Timeframe: {TIMEFRAME}")
    print(f"Period: {PARITY_START.strftime('%Y-%m-%d')} -> {PARITY_END.strftime('%Y-%m-%d')}")
    print(f"RSI({RSI_PERIOD}), oversold={OVERSOLD}, overbought={OVERBOUGHT}")
    print(f"SL={SL_PCT}%, TP={TP_PCT}%, timeout={TIMEOUT_BARS} bars")
    print(f"Capital: $10,000, Position: 5%")
    print()

    df = load_candles()
    print(f"Loaded {len(df)} candles ({len(df) / 288:.1f} days)")

    bt = Backtest(
        df,
        RsiReversal,
        cash=10_000_000,  # scale up to avoid fractional BTC issue
        commission=0.0004,
        exclusive_orders=True,
        trade_on_close=True,
    )

    stats = bt.run()

    print(f"\n=== backtesting.py Results ===")
    print(f"Final Equity:    ${stats['Equity Final [$]']:.2f}")
    print(f"Net PnL:         ${stats['Equity Final [$]'] - 10000:.2f}")
    print(f"Total Trades:    {stats['# Trades']}")
    print(f"Win Rate:        {stats['Win Rate [%]']:.1f}%")
    print(f"Profit Factor:   {stats.get('Profit Factor', 'N/A')}")
    print(f"Max Drawdown:    {stats['Max. Drawdown [%]']:.2f}%")
    print(f"Avg Win:         ${stats.get('Avg. Trade [%]', 0):.2f}%")

    # Print individual trades
    trades = stats['_trades']
    print(f"\n=== Trade Log ({len(trades)} trades) ===")
    for i, trade in trades.iterrows():
        side = "L" if trade['Size'] > 0 else "S"
        entry_time = trade['EntryTime'].strftime('%Y-%m-%d %H:%M')
        exit_time = trade['ExitTime'].strftime('%Y-%m-%d %H:%M')
        pnl = trade['PnL']
        entry_price = trade['EntryPrice']
        exit_price = trade['ExitPrice']
        print(f"  #{i+1:3d} {side} entry={entry_price:.2f} exit={exit_price:.2f} pnl={pnl:+.2f}  {entry_time} -> {exit_time}")

    # Also dump RSI values at first few candles for comparison
    rsi = wilder_rsi(df['Close'], RSI_PERIOD)
    parity_rsi = rsi[rsi.index >= PARITY_START]

    print(f"\n=== First 10 RSI values in parity period ===")
    for i, (idx, val) in enumerate(parity_rsi.head(10).items()):
        close = df.loc[idx, 'Close']
        print(f"  {idx.strftime('%Y-%m-%d %H:%M')}  close={close:.2f}  rsi={val:.6f}")


if __name__ == "__main__":
    main()
