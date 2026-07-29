import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { SessionComposerInput } from './SessionComposerInput';
import { ComposerPluginActions } from './ComposerPluginActions';

describe('ComposerPluginActions', () => {
  it('inserts an editable PluginAction into the composer without sending', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        return {
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
              artifactIntent: {
                mediaTypes: [
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                ],
                provider: 'officecli',
              },
            },
          ],
          readiness: {
            enabled: true,
            dependency: { id: 'officecli', status: 'ready' },
          },
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
          <ComposerPluginActions
            transport={transport}
            message={message}
            onMessageChange={setMessage}
          />
          <SessionComposerInput
            value={message}
            images={[]}
            onChange={setMessage}
            onSubmit={onSubmit}
            onAttachImages={() => {}}
            onRemoveImage={() => {}}
          />
        </QueryClientProvider>
      );
    }

    render(<Harness />);
    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));

    expect(screen.getByRole('textbox').textContent).toBe(
      '保留我的开场。\n\n澄清受众与目标后，创建新的 PPTX 并验证输出。'
    );
    expect(screen.getByText('Skill · office-pptx')).toBeVisible();
    expect(screen.getByText('Tool · officecli')).toBeVisible();
    expect(screen.getByText('Artifact · PPTX')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
