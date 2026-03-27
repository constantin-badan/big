import { ExchangeApiError } from '../errors';
import { buildQueryString } from './signing';

export class RestClient {
  private readonly restBase: string;
  private readonly apiKey: string;

  constructor(restBase: string, apiKey: string) {
    this.restBase = restBase;
    this.apiKey = apiKey;
  }

  async restGet(
    path: string,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const qs = buildQueryString(params);
    const url = `${this.restBase}${path}?${qs}`;
    const response = await fetch(url, {
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new ExchangeApiError(response.status, `Binance REST ${response.status}: ${body.substring(0, 500)}`);
    }
    return response.json();
  }

  async restPost(
    path: string,
    params: Record<string, string | number>,
  ): Promise<unknown> {
    const url = `${this.restBase}${path}`;
    const body = buildQueryString(params);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!response.ok) {
      const respBody = await response.text();
      throw new ExchangeApiError(response.status, `Binance REST ${response.status}: ${respBody.substring(0, 500)}`);
    }
    return response.json();
  }
}
