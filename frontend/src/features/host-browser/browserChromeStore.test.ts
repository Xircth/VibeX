import { describe, expect, it } from 'vitest';

import {
  applyBrowserHostEvent,
  getAgentActivity,
  getBrowserNotice,
  getEvalRequest,
  resetBrowserChromeForTests,
} from './browserChromeStore';

describe('browserChromeStore', () => {
  it('merges consecutive agent activity and caps growth', () => {
    resetBrowserChromeForTests();
    applyBrowserHostEvent({
      kind: 'agent.activity',
      tabId: 't1',
      action: 'read',
      outcome: 'done',
      at: 1,
    });
    applyBrowserHostEvent({
      kind: 'agent.activity',
      tabId: 't1',
      action: 'read',
      outcome: 'done',
      at: 2,
    });
    applyBrowserHostEvent({
      kind: 'agent.activity',
      tabId: 't1',
      action: 'click',
      outcome: 'refused',
      at: 3,
    });
    const rows = getAgentActivity('t1');
    expect(rows[0]).toMatchObject({ action: 'click', outcome: 'refused', count: 1 });
    expect(rows[1]).toMatchObject({ action: 'read', outcome: 'done', count: 2 });
  });

  it('records popup denials and eval requests without polling', () => {
    resetBrowserChromeForTests();
    applyBrowserHostEvent({
      kind: 'popup.denied',
      sourceTabId: 't1',
      url: 'https://ads.example/',
      reason: 'no-gesture',
    });
    applyBrowserHostEvent({
      kind: 'eval.request',
      requestId: 'r1',
      tabId: 't1',
      code: 'return 1',
      expiresAt: 9,
    });
    expect(getBrowserNotice('t1')).toEqual({
      kind: 'popup-denied',
      url: 'https://ads.example/',
      reason: 'no-gesture',
    });
    expect(getEvalRequest()?.requestId).toBe('r1');
  });
});
