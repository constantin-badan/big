import type { ExchangeStream, RiskRule, RiskSeverity } from '@trading-bot/types';

import { ConnectionError } from '../errors';

// Reconnection config
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_JITTER_MS = 500;
export const RECONNECT_KILL_AFTER = 10;

// Binance close codes indicating scheduled maintenance (skip reconnect loop)
export const MAINTENANCE_CLOSE_CODES = new Set([1001, 1012]);

export function reconnectDelay(attempt: number): number {
  const exponential = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt),
    RECONNECT_MAX_DELAY_MS,
  );
  const jitter = Math.random() * RECONNECT_JITTER_MS;
  return exponential + jitter;
}

function isMaintenanceClose(code: number): boolean {
  return MAINTENANCE_CLOSE_CODES.has(code);
}

export interface WsConnectionCallbacks {
  onConnected: (payload: { stream: ExchangeStream; symbol: string; timestamp: number }) => void;
  onDisconnected: (payload: {
    stream: ExchangeStream;
    symbol: string;
    reason: 'ping_timeout' | 'server_close' | 'network_error' | 'manual' | 'maintenance';
    timestamp: number;
  }) => void;
  onReconnecting: (payload: {
    stream: ExchangeStream;
    symbol: string;
    attempt: number;
    timestamp: number;
  }) => void;
  onReconnectExhausted: (payload: {
    rule: RiskRule;
    message: string;
    severity: RiskSeverity;
  }) => void;
  onMessage: (data: string) => void;
}

export class WsConnection {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private intentionalDisconnect = false;

  private readonly streamLabel: ExchangeStream;
  private readonly callbacks: WsConnectionCallbacks;

  constructor(streamLabel: ExchangeStream, callbacks: WsConnectionCallbacks) {
    this.streamLabel = streamLabel;
    this.callbacks = callbacks;
  }

  /** Open a WebSocket to the given URL. Resolves when the connection is open. */
  open(url: string): Promise<void> {
    this.intentionalDisconnect = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let resolved = false;

      ws.addEventListener('open', () => {
        this.ws = ws;
        this.connected = true;
        this.reconnectAttempt = 0;
        if (!resolved) {
          resolved = true;
          resolve();
        }
        this.callbacks.onConnected({
          stream: this.streamLabel,
          symbol: '*',
          timestamp: Date.now(),
        });
      });

      ws.addEventListener('error', () => {
        if (!resolved) {
          resolved = true;
          reject(new ConnectionError(`${this.streamLabel} WS connection failed`));
        }
      });

      ws.addEventListener('message', (event) => {
        this.callbacks.onMessage(String(event.data));
      });

      ws.addEventListener('close', (event: CloseEvent) => {
        this.ws = null;
        this.connected = false;
        if (this.intentionalDisconnect) return;

        const maintenance = isMaintenanceClose(event.code);
        this.callbacks.onDisconnected({
          stream: this.streamLabel,
          symbol: '*',
          reason: maintenance ? 'maintenance' : 'server_close',
          timestamp: Date.now(),
        });

        if (!maintenance) {
          void this.reconnect(url);
        }
      });
    });
  }

  /** Close the connection intentionally; suppresses reconnection. */
  close(): void {
    this.intentionalDisconnect = true;
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Whether the WebSocket is currently open. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Underlying WebSocket instance (null when disconnected). */
  getSocket(): WebSocket | null {
    return this.ws;
  }

  /** Send raw data on the WebSocket. Throws if not connected. */
  send(data: string): void {
    if (!this.ws) {
      throw new Error(`${this.streamLabel} WS not connected`);
    }
    this.ws.send(data);
  }

  /**
   * Hook for post-reconnect logic (e.g. re-authenticating).
   * If set, this is called after each successful reconnect before the loop exits.
   */
  onReconnected: (() => Promise<void>) | null = null;

  private async reconnect(url: string): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      while (!this.intentionalDisconnect) {
        this.reconnectAttempt++;
        const delay = reconnectDelay(this.reconnectAttempt);

        this.callbacks.onReconnecting({
          stream: this.streamLabel,
          symbol: '*',
          attempt: this.reconnectAttempt,
          timestamp: Date.now(),
        });

        if (this.reconnectAttempt >= RECONNECT_KILL_AFTER) {
          this.callbacks.onReconnectExhausted({
            rule: 'MAX_DAILY_LOSS',
            message: `${this.streamLabel} WS reconnect failed after ${this.reconnectAttempt} attempts`,
            severity: 'KILL',
          });
          return;
        }

        await new Promise<void>((r) => setTimeout(r, delay));
        if (this.intentionalDisconnect) return;

        try {
          await this.open(url);
          if (this.onReconnected) {
            await this.onReconnected();
          }
          return;
        } catch {
          // retry
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }
}
