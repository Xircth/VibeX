import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserEvalConfirm } from './BrowserEvalConfirm';
import {
  resetBrowserChromeForTests,
  setEvalRequest,
} from './browserChromeStore';

const backendCall = vi.hoisted(() => vi.fn());

vi.mock('@/lib/backendTransport', () => ({
  backendCall,
}));

function renderConfirm() {
  return render(
    <HotkeysProvider initiallyActiveScopes={['dialog', 'kanban', 'projects']}>
      <BrowserEvalConfirm />
    </HotkeysProvider>
  );
}

describe('BrowserEvalConfirm', () => {
  beforeEach(() => {
    backendCall.mockReset();
    backendCall.mockResolvedValue(undefined);
    resetBrowserChromeForTests();
  });

  it('renders nothing without a pending eval request', () => {
    renderConfirm();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('allows a pending eval and reports the decision to the host', async () => {
    const user = userEvent.setup();
    setEvalRequest({
      requestId: 'r1',
      tabId: 't1',
      pluginId: 'example.browser',
      origin: 'https://example.com',
      title: 'Example',
      code: 'return 1',
      expiresAt: Date.now() + 60_000,
    });

    renderConfirm();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('return 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '允许' }));

    expect(backendCall).toHaveBeenCalledWith('plugin_invoke_contribution', {
      pluginId: 'example.browser',
      handler: 'browser.dispatch',
      input: {
        operation: 'eval.decide',
        input: { requestId: 'r1', allow: true },
      },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
