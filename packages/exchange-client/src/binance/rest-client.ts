import { ExchangeApiError } from '../errors';
import { buildQueryString } from './signing';

const DEFAULT_TIMEOUT_MS = 30_000;

export class RestClient {
  private readonly restBase: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  // Token bucket rate limiter
  private tokens: number;
  private lastRefillTime: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(
    restBase: string,
    apiKey: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    rateLimitPerMinute: number = 1200,
  ) {
    this.restBase = restBase;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;

    this.maxTokens = Math.max(1, Math.floor(rateLimitPerMinute * 0.05));
    this.refillRate = rateLimitPerMinute / 60_000;
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
  }

  private async consumeToken(weight = 1): Promise<void> {
    const now = Date.now();
    this.tokens = Math.min(this.maxTokens, this.tokens + (now - this.lastRefillTime) * this.refillRate);
    this.lastRefillTime = now;
    if (this.tokens >= weight) {
      this.tokens -= weight;
      return;
    }
    const waitMs = Math.ceil((weight - this.tokens) / this.refillRate);
    await new Promise<void>(resolve => setTimeout(resolve, waitMs));
    const after = Date.now();
    this.tokens = Math.min(this.maxTokens, this.tokens + (after - this.lastRefillTime) * this.refillRate);
    this.lastRefillTime = after;
    // Guard: concurrent callers may have consumed tokens during our wait
    this.tokens = Math.max(0, this.tokens - weight);
  }

  async restGet(path: string, params: Record<string, string | number>): Promise<unknown> {
    await this.consumeToken();
    const qs = buildQueryString(params);
    const url = `${this.restBase}${path}?${qs}`;
    const response = await fetch(url, {
      headers: { 'X-MBX-APIKEY': this.apiKey },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new ExchangeApiError(
        response.status,
        `Binance REST ${response.status}: ${body.substring(0, 500)}`,
      );
    }
    try {
      return await response.json();
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new ExchangeApiError(
          response.status,
          `Binance REST ${response.status}: invalid JSON in response body`,
        );
      }
      throw err;
    }
  }

  async restPost(path: string, params: Record<string, string | number>): Promise<unknown> {
    await this.consumeToken();
    const url = `${this.restBase}${path}`;
    const body = buildQueryString(params);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const respBody = await response.text();
      throw new ExchangeApiError(
        response.status,
        `Binance REST ${response.status}: ${respBody.substring(0, 500)}`,
      );
    }
    try {
      return await response.json();
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new ExchangeApiError(
          response.status,
          `Binance REST ${response.status}: invalid JSON in response body`,
        );
      }
      throw err;
    }
  }
}
