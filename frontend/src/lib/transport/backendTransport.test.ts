import { createElement, useEffect } from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  conversationApi,
  createConversationApi,
} from '@/features/conversation/conversationApi';
import { automationApi } from '@/lib/api/automations';
import { pluginControlApi } from '@/lib/api/plugins';
import {
  backendCall,
  backendEmit,
  backendListen,
  configureBackendTransport,
} from '@/lib/backendTransport';
import type { BackendTransport } from './backendTransport';
import { BackendTransportProvider } from './BackendTransportProvider';
import { tauriBackendTransport } from './tauriTransport';
import { mountBackendTransport } from './transportRegistry';

vi.mock('@tauri-apps/api/core', () => {
  throw new Error('feature tests must not import @tauri-apps/api');
});

describe('BackendTransport conversation tracer', () => {
  afterEach(() => {
    configureBackendTransport(tauriBackendTransport);
  });

  it('lists conversations through an injected transport without importing Tauri', async () => {
    const call = vi.fn().mockResolvedValue([
      {
        id: 'conversation-1',
        workspace_id: 'workspace-1',
        title: 'Transport-neutral',
      },
    ]);
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    const conversations =
      await createConversationApi(transport).list('workspace-1');

    expect(conversations[0]?.title).toBe('Transport-neutral');
    expect(call).toHaveBeenCalledWith('conversation_list', {
      workspaceId: 'workspace-1',
    });
  });

  it('routes migrated calls and event listeners through the configured transport', async () => {
    const unlisten = vi.fn();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const listen = vi.fn().mockResolvedValue(unlisten);
    const emit = vi.fn().mockResolvedValue(undefined);
    configureBackendTransport({
      environment: 'web',
      call,
      listen,
      emit,
    });
    const handler = vi.fn();

    await expect(backendCall('health_check')).resolves.toEqual({ ok: true });
    await expect(backendListen('conversation-events', handler)).resolves.toBe(
      unlisten
    );
    await expect(backendEmit('theme-changed', { theme: 'dark' })).resolves.toBe(
      undefined
    );
    expect(call).toHaveBeenCalledWith('health_check', undefined);
    expect(listen).toHaveBeenCalledWith('conversation-events', handler);
    expect(emit).toHaveBeenCalledWith('theme-changed', { theme: 'dark' });
  });

  it('makes a provider transport available before descendant effects run', async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const transport: BackendTransport = {
      environment: 'web',
      call,
    };
    function CallOnMount() {
      useEffect(() => {
        void backendCall('conversation_list');
      }, []);
      return null;
    }

    const view = render(
      createElement(
        BackendTransportProvider,
        { transport },
        createElement(CallOnMount)
      )
    );

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('conversation_list', undefined)
    );
    view.unmount();
  });

  it('keeps exported domain facades bound to the provider selected at runtime', async () => {
    const call = vi.fn().mockResolvedValue([]);
    configureBackendTransport({
      environment: 'web',
      call,
    });

    await conversationApi.list('workspace-1');
    await automationApi.templates();
    await pluginControlApi.contributionCatalog();

    expect(call.mock.calls).toEqual([
      ['conversation_list', { workspaceId: 'workspace-1' }],
      ['automation_templates', undefined],
      ['plugin_contribution_catalog', undefined],
    ]);
  });

  it('rejects multiple process-wide providers instead of splitting facade and context semantics', () => {
    const first: BackendTransport = {
      environment: 'web',
      call: vi.fn(),
    };
    const second: BackendTransport = {
      environment: 'remote-desktop',
      call: vi.fn(),
    };
    const release = mountBackendTransport(first);
    try {
      expect(() => mountBackendTransport(second)).toThrow(
        'Only one BackendTransportProvider may be mounted'
      );
    } finally {
      release();
    }
  });
});
