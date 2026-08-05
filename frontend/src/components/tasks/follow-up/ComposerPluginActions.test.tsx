import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

async function typeAtEnd(editor: HTMLDivElement, value: string) {
  await act(async () => {
    editor.focus();
    editor.textContent = value;
    const text = editor.firstChild;
    if (!text) throw new Error('expected editor text node');
    const range = document.createRange();
    range.setStart(text, value.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.input(editor);
    await Promise.resolve();
  });
}

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
      const [message, setMessage] = useState('保留我的开场。');
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
    const editor = screen.getByRole('textbox') as HTMLDivElement;
    expect(call).not.toHaveBeenCalled();

    await typeAtEnd(editor, '保留我的开场。 !');

    expect(await screen.findByText('调用插件')).toBeVisible();
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
    ).toBe('保留我的开场。 澄清受众与目标后，创建新的 PPTX 并验证输出。 ');
    expect(screen.getByTestId('session-composer-token-chip')).toHaveAttribute(
      'data-token-kind',
      'plugin_action'
    );
    expect(screen.getByTestId('session-composer-token-chip')).toHaveTextContent(
      '!创建 PPT'
    );
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
    expect(call).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
