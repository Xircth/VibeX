import type { BrowserEvent, BrowserIntent, BrowserTabId } from './browserTypes';

const MAX_PENDING_REQUESTS = 64;
const REQUEST_TIMEOUT_MS = 15_000;

type Dispatch = (intent: BrowserIntent) => Promise<void>;
type EventListener = (params: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function protocolError(result: unknown): Error {
  if (
    typeof result === 'object' &&
    result !== null &&
    'message' in result &&
    typeof result.message === 'string'
  ) {
    return new Error(result.message);
  }
  return new Error('Chromium rejected the DevTools Protocol request.');
}

export class BrowserDevToolsSession {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(
    private readonly tabId: BrowserTabId,
    private readonly dispatch: Dispatch
  ) {}

  execute(method: string, params: unknown = {}): Promise<unknown> {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new Error('Too many pending Chromium DevTools Protocol requests.')
      );
    }

    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`DevTools Protocol request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timeout });

      void this.dispatch({
        type: 'executeDevTools',
        requestId,
        method,
        params,
      }).catch((error: unknown) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(
          error instanceof Error ? error : new Error(String(error))
        );
      });
    });
  }

  receive(event: BrowserEvent): void {
    if (
      (event.type !== 'devToolsResult' && event.type !== 'devToolsEvent') ||
      event.tabId !== this.tabId
    ) {
      return;
    }

    if (event.type === 'devToolsEvent') {
      this.listeners
        .get(event.method)
        ?.forEach((listener) => listener(event.params));
      return;
    }

    const pending = this.pending.get(event.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(event.requestId);
    if (event.success) pending.resolve(event.result);
    else pending.reject(protocolError(event.result));
  }

  on(method: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(method) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  dispose(): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(new Error('The Chromium tab was closed.'));
    });
    this.pending.clear();
    this.listeners.clear();
  }
}
