import { ConnectionError, RequestTimeoutError } from '../errors';

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  requestTime: number;
  timer: ReturnType<typeof setTimeout>;
}

export const WS_REQUEST_TIMEOUT_MS = 30_000;

export class RequestTracker {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private requestIdCounter = 0;

  /** Generate the next unique request ID. */
  nextId(): string {
    return String(++this.requestIdCounter);
  }

  /**
   * Register a pending request with a timeout.
   * Returns a Promise that resolves/rejects when the response arrives or times out.
   */
  track(id: string, method: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new RequestTimeoutError(
            `WS API request timed out after ${WS_REQUEST_TIMEOUT_MS}ms: ${method}`,
          ),
        );
      }, WS_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, requestTime: Date.now(), timer });
    });
  }

  /**
   * Resolve a pending request with a successful result.
   * Returns true if the request was found and resolved.
   */
  resolve(id: string, result: unknown): boolean {
    const pending = this.pendingRequests.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);
    pending.resolve(result);
    return true;
  }

  /**
   * Reject a pending request with an error.
   * Returns true if the request was found and rejected.
   */
  reject(id: string, error: Error): boolean {
    const pending = this.pendingRequests.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);
    pending.reject(error);
    return true;
  }

  /** Check whether a pending request exists for the given ID. */
  has(id: string): boolean {
    return this.pendingRequests.has(id);
  }

  /** Reject all pending requests (e.g. on disconnect) and clear timers. */
  rejectAll(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectionError(reason));
    }
    this.pendingRequests.clear();
  }
}
