import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { SessionComposerInput } from './SessionComposerInput';
import {
  formatSessionComposerCommand,
  getSessionComposerPluginActionInvocations,
  serializeSessionComposerBackendMessage,
} from './sessionComposerStructuredTokens';

vi.mock('@/lib/api', () => ({
  fileTreeApi: {},
  repoApi: {},
  skillsApi: {
    listLocal: vi.fn().mockResolvedValue([]),
  },
}));

describe('composer plugin action invocation', () => {
  it('opens plugin actions after space-bang and inserts the selection without submitting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        return {
          plugin: {
            id: 'vibex.office',
            name: 'VibeX Office',
            version: '2.0.0',
            membership: 'builtin',
          },
          actions: [
            {
              pluginId: 'vibex.office',
              actionId: 'create-presentation',
              label: '创建 PPT',
              requiredSkills: ['office-pptx'],
              requiredTools: ['officecli'],
              promptBlocks: [
                {
                  type: 'text',
                  text: '澄清受众与目标后，创建新的 PPTX 并验证输出。',
                },
              ],
              artifactIntent: null,
            },
          ],
          readiness: {
            enabled: true,
            dependency: {
              id: 'officecli',
              status: 'ready',
              version: '1.0.140',
              error: null,
            },
            skills: [
              {
                id: 'office-pptx',
                status: 'ready',
                version: null,
                error: null,
              },
            ],
            providers: [],
            overall: 'ready',
          },
        };
      }
      if (command === 'list_agent_skills') {
        return {
          supported: true,
          locations: [],
          skills: [
            {
              id: 'office-pptx',
              scope: 'global',
              path: '/tmp/office-pptx',
              description: null,
              read_only: false,
            },
          ],
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function Harness() {
      const [message, setMessage] = useState('');
      return (
        <QueryClientProvider client={queryClient}>
          <SessionComposerInput
            value={message}
            context={{
              transport,
              executorProfile: { executor: 'codex' },
            }}
            images={[]}
            onChange={setMessage}
            onSubmit={onSubmit}
            onAttachImages={() => {}}
            onRemoveImage={() => {}}
          />
          <output data-testid="composer-value">{message}</output>
        </QueryClientProvider>
      );
    }

    render(<Harness />);
    const surface = screen.getByTestId('session-composer-editor');
    const editor = surface.querySelector(
      '[contenteditable="true"]'
    ) as HTMLDivElement;

    await user.click(editor);
    await user.type(editor, '保留我的开场。 !');

    await user.click(await screen.findByRole('option', { name: /创建 PPT/ }));

    const command = formatSessionComposerCommand({
      type: '!',
      key: 'vibex.office/create-presentation|创建 PPT',
      value: '',
    });
    expect(screen.getByTestId('composer-value')).toHaveTextContent(
      `保留我的开场。 ${command}澄清受众与目标后，创建新的 PPTX 并验证输出。`
    );
    expect(
      serializeSessionComposerBackendMessage(
        screen.getByTestId('composer-value').textContent ?? ''
      )
    ).toBe('保留我的开场。 澄清受众与目标后，创建新的 PPTX 并验证输出。');
    expect(
      getSessionComposerPluginActionInvocations(
        screen.getByTestId('composer-value').textContent ?? ''
      )
    ).toEqual([
      {
        pluginId: 'vibex.office',
        actionId: 'create-presentation',
      },
    ]);
    expect(call.mock.calls.map((c) => c[0])).toContain(
      'plugin_action_catalog'
    );
    expect(call.mock.calls.map((c) => c[0])).toContain('list_agent_skills');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
