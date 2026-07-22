import { describe, expect, it, vi } from 'vitest';
import { BrowserDevToolsSession } from './devToolsSession';

describe('BrowserDevToolsSession', () => {
  it('correlates concurrent CDP requests without leaking protocol details', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const session = new BrowserDevToolsSession('tab-1', dispatch);

    const title = session.execute('Runtime.evaluate', {
      expression: 'document.title',
    });
    const document = session.execute('DOM.getDocument');

    expect(dispatch).toHaveBeenNthCalledWith(1, {
      type: 'executeDevTools',
      requestId: 1,
      method: 'Runtime.evaluate',
      params: { expression: 'document.title' },
    });
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: 'executeDevTools',
      requestId: 2,
      method: 'DOM.getDocument',
      params: {},
    });

    session.receive({
      type: 'devToolsResult',
      tabId: 'tab-1',
      requestId: 2,
      success: true,
      result: { root: { nodeId: 1 } },
    });
    session.receive({
      type: 'devToolsResult',
      tabId: 'tab-1',
      requestId: 1,
      success: true,
      result: { result: { value: 'Example' } },
    });

    await expect(title).resolves.toEqual({ result: { value: 'Example' } });
    await expect(document).resolves.toEqual({ root: { nodeId: 1 } });
  });

  it('publishes bounded CDP events and rejects failed requests', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const session = new BrowserDevToolsSession('tab-1', dispatch);
    const onConsole = vi.fn();
    const unsubscribe = session.on('Runtime.consoleAPICalled', onConsole);
    const request = session.execute('Page.captureScreenshot');

    session.receive({
      type: 'devToolsEvent',
      tabId: 'tab-1',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error' },
    });
    session.receive({
      type: 'devToolsResult',
      tabId: 'tab-1',
      requestId: 1,
      success: false,
      result: { message: 'capture failed' },
    });

    expect(onConsole).toHaveBeenCalledWith({ type: 'error' });
    await expect(request).rejects.toThrow('capture failed');
    unsubscribe();
  });
});
