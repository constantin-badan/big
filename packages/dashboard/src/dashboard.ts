import type {
  ExchangeStream,
  IEventBus,
  OrderResult,
  Position,
  RiskRule,
  RiskSeverity,
  SubmissionReceipt,
  Signal,
  TradeRecord,
  TradingEventMap,
  ClientOrderId,
} from '@trading-bot/types';

// === Dashboard State ===

interface OpenPositionEntry {
  symbol: string;
  side: string;
  entryPrice: number;
  entryTime: number;
}

interface RecentTradeEntry {
  symbol: string;
  side: string;
  pnl: number;
  exitReason: string;
  time: number;
}

interface RiskBreachEntry {
  rule: string;
  message: string;
  time: number;
}

interface LastSignalEntry {
  symbol: string;
  action: string;
  time: number;
}

interface DashboardState {
  openPositions: Map<string, OpenPositionEntry>;
  recentTrades: RecentTradeEntry[];
  totalPnl: number;
  winCount: number;
  lossCount: number;
  connectionStatus: Map<string, boolean>;
  riskBreaches: RiskBreachEntry[];
  lastSignal: LastSignalEntry | null;
  pendingOrders: number;
  startTime: number;
}

// === ANSI Helpers ===

const CLEAR = '\x1b[2J\x1b[H';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

const WIDTH = 60;

function hLine(left: string, right: string, fill: string, width: number): string {
  return left + fill.repeat(width - 2) + right;
}

function padRow(content: string, width: number): string {
  // Strip ANSI codes to measure visible length
  const visible = content.replace(/\u001b\[[0-9;]*m/g, '');
  const pad = width - 2 - visible.length;
  if (pad <= 0) return `\u2502 ${content}${RESET}\u2502`;
  return `\u2502 ${content}${' '.repeat(pad)}\u2502`;
}

function sectionHeader(title: string, width: number): string {
  const inner = `\u2500 ${title} `;
  const remaining = width - 2 - inner.length;
  return `\u251C${inner}${'\u2500'.repeat(Math.max(0, remaining))}\u2524`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatTimeAgo(timestamp: number, now: number): string {
  const diff = now - timestamp;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function colorPnl(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  const color = pnl >= 0 ? GREEN : RED;
  return `${color}${sign}$${pnl.toFixed(2)}${RESET}`;
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return price.toFixed(4);
}

// === Dashboard ===

export class Dashboard {
  private readonly bus: IEventBus;
  private state: DashboardState;
  private renderInterval: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(bus: IEventBus) {
    this.bus = bus;
    this.state = {
      openPositions: new Map(),
      recentTrades: [],
      totalPnl: 0,
      winCount: 0,
      lossCount: 0,
      connectionStatus: new Map(),
      riskBreaches: [],
      lastSignal: null,
      pendingOrders: 0,
      startTime: Date.now(),
    };
  }

  start(): void {
    this.subscribeAll();
    this.renderInterval = setInterval(() => this.render(), 500);
    // Initial render
    this.render();
  }

  stop(): void {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes.length = 0;
  }

  private render(): void {
    process.stdout.write(CLEAR + this.buildOutput());
  }

  // === Event Subscriptions ===

  private subscribeAll(): void {
    this.sub('position:opened', (data: { position: Position }) => {
      const p = data.position;
      this.state.openPositions.set(String(p.symbol), {
        symbol: String(p.symbol),
        side: p.side,
        entryPrice: p.entryPrice,
        entryTime: p.timestamp,
      });
    });

    this.sub('position:closed', (data: { position: Position; trade: TradeRecord }) => {
      const t = data.trade;
      this.state.openPositions.delete(String(t.symbol));
      this.state.recentTrades.unshift({
        symbol: String(t.symbol),
        side: t.side,
        pnl: t.pnl,
        exitReason: t.exitReason,
        time: t.exitTime,
      });
      if (this.state.recentTrades.length > 20) {
        this.state.recentTrades.length = 20;
      }
      this.state.totalPnl += t.pnl;
      if (t.pnl >= 0) {
        this.state.winCount++;
      } else {
        this.state.lossCount++;
      }
    });

    this.sub('order:submitted', (_data: { receipt: SubmissionReceipt }) => {
      this.state.pendingOrders++;
    });

    this.sub('order:filled', (_data: { order: OrderResult }) => {
      this.state.pendingOrders = Math.max(0, this.state.pendingOrders - 1);
    });

    this.sub('order:rejected', (_data: { clientOrderId: ClientOrderId; reason: string }) => {
      this.state.pendingOrders = Math.max(0, this.state.pendingOrders - 1);
    });

    this.sub('order:canceled', (_data: { order: OrderResult }) => {
      this.state.pendingOrders = Math.max(0, this.state.pendingOrders - 1);
    });

    this.sub('signal', (data: { signal: Signal }) => {
      const s = data.signal;
      this.state.lastSignal = {
        symbol: String(s.symbol),
        action: s.action,
        time: s.timestamp,
      };
    });

    this.sub('risk:breach', (data: { rule: RiskRule; message: string; severity: RiskSeverity }) => {
      this.state.riskBreaches.unshift({
        rule: data.rule,
        message: data.message,
        time: Date.now(),
      });
      if (this.state.riskBreaches.length > 5) {
        this.state.riskBreaches.length = 5;
      }
    });

    this.sub('exchange:connected', (data: { stream: ExchangeStream; symbol: string; timestamp: number }) => {
      this.state.connectionStatus.set(data.stream, true);
    });

    this.sub('exchange:disconnected', (data: { stream: ExchangeStream; symbol: string; reason: string; timestamp: number }) => {
      this.state.connectionStatus.set(data.stream, false);
    });
  }

  private sub<K extends keyof TradingEventMap>(
    event: K,
    handler: (data: TradingEventMap[K]) => void,
  ): void {
    this.bus.on(event, handler);
    this.unsubscribes.push(() => this.bus.off(event, handler));
  }

  // === Renderer ===

  private buildOutput(): string {
    const now = Date.now();
    const lines: string[] = [];

    // Title bar
    lines.push(hLine('\u250C', '\u2510', '\u2500', WIDTH));
    const title = `${BOLD} Trading Bot Dashboard${RESET}`;
    lines.push(padRow(title, WIDTH));

    // Summary row
    const uptime = formatDuration(now - this.state.startTime);
    const pnl = colorPnl(this.state.totalPnl);
    const wl = `W/L: ${this.state.winCount}/${this.state.lossCount}`;
    lines.push(padRow(`Uptime: ${uptime}  ${DIM}\u2502${RESET}  PnL: ${pnl}  ${DIM}\u2502${RESET}  ${wl}`, WIDTH));

    // Open Positions
    lines.push(sectionHeader('Open Positions', WIDTH));
    if (this.state.openPositions.size === 0) {
      lines.push(padRow(`${DIM}(none)${RESET}`, WIDTH));
    } else {
      for (const pos of this.state.openPositions.values()) {
        const held = formatDuration(now - pos.entryTime);
        const sideColor = pos.side === 'LONG' ? GREEN : RED;
        lines.push(padRow(
          `${BOLD}${pos.symbol}${RESET}  ${sideColor}${pos.side}${RESET}  @ ${formatPrice(pos.entryPrice)}  (held ${held})`,
          WIDTH,
        ));
      }
    }

    // Recent Trades (show last 5 in the display)
    const displayTrades = this.state.recentTrades.slice(0, 5);
    lines.push(sectionHeader(`Recent Trades (last ${displayTrades.length})`, WIDTH));
    if (displayTrades.length === 0) {
      lines.push(padRow(`${DIM}(none)${RESET}`, WIDTH));
    } else {
      for (const trade of displayTrades) {
        const ago = formatTimeAgo(trade.time, now);
        const pnlStr = colorPnl(trade.pnl);
        const reason = trade.exitReason.replace('_', ' ');
        lines.push(padRow(
          `${BOLD}${trade.symbol}${RESET}  ${pnlStr}  ${DIM}${reason}${RESET}  ${ago}`,
          WIDTH,
        ));
      }
    }

    // Status
    lines.push(sectionHeader('Status', WIDTH));
    const connParts: string[] = [];
    if (this.state.connectionStatus.size === 0) {
      connParts.push(`${DIM}no streams${RESET}`);
    } else {
      for (const [stream, connected] of this.state.connectionStatus) {
        const dot = connected ? `${GREEN}\u25CF${RESET}` : `${RED}\u25CF${RESET}`;
        connParts.push(`${dot} ${stream}`);
      }
    }
    lines.push(padRow(
      `Connections: ${connParts.join(' ')}  ${DIM}\u2502${RESET}  Pending: ${this.state.pendingOrders}`,
      WIDTH,
    ));

    if (this.state.lastSignal) {
      const ago = formatTimeAgo(this.state.lastSignal.time, now);
      lines.push(padRow(
        `Last Signal: ${BOLD}${this.state.lastSignal.symbol}${RESET} ${YELLOW}${this.state.lastSignal.action}${RESET} (${ago})`,
        WIDTH,
      ));
    } else {
      lines.push(padRow(`Last Signal: ${DIM}(none)${RESET}`, WIDTH));
    }

    // Risk
    lines.push(sectionHeader('Risk', WIDTH));
    if (this.state.riskBreaches.length === 0) {
      lines.push(padRow(`${DIM}(no breaches)${RESET}`, WIDTH));
    } else {
      for (const breach of this.state.riskBreaches) {
        const ago = formatTimeAgo(breach.time, now);
        lines.push(padRow(
          `${RED}${BOLD}${breach.rule}${RESET}: ${breach.message}  ${DIM}${ago}${RESET}`,
          WIDTH,
        ));
      }
    }

    // Bottom border
    lines.push(hLine('\u2514', '\u2518', '\u2500', WIDTH));

    return lines.join('\n') + '\n';
  }
}
