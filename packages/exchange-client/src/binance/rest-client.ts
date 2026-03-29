import { ExchangeApiError } from '../errors';
import { buildQueryString } from './signing';

const DEFAULT_TIMEOUT_MS = 30_000;

export class RestClient {
  private readonly restBase: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(restBase: string, apiKey: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.restBase = restBase;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async restGet(path: string, params: Record<string, string | number>): Promise<unknown> {
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
