import { beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';

import { generateTerminalTabId, useTerminalStore } from './useTerminalStore';

describe('useTerminalStore persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    useTerminalStore.setState({
      sessionsByWorkspace: {},
      activeTabByWorkspace: {},
    });
  });

  it('does not persist PTY session ids across reloads', async () => {
    const tabId = generateTerminalTabId();
    useTerminalStore.getState().addSession('workspace-1', tabId, 'zsh', {
      sessionId: 'pty-live-id',
    });
    useTerminalStore.getState().setSessionId(tabId, 'pty-live-id');

    await waitFor(() => {
      const persisted = JSON.parse(
        localStorage.getItem('vibex-terminal-sessions') ?? '{}'
      ) as {
        state?: {
          sessionsByWorkspace?: Record<
            string,
            Array<{ tabId: string; sessionId: string | null }>
          >;
        };
      };
      expect(
        persisted.state?.sessionsByWorkspace?.['workspace-1']?.[0]?.sessionId
      ).toBeNull();
      expect(
        persisted.state?.sessionsByWorkspace?.['workspace-1']?.[0]?.tabId
      ).toBe(tabId);
    });
  });
});
