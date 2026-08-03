import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { SessionComposerInput } from './SessionComposerInput';
import { ComposerPluginActions } from './ComposerPluginActions';

describe('ComposerPluginActions', () => {
  it('does not expose enabled plugin actions as composer shortcut buttons', async () => {
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
          <ComposerPluginActions transport={transport} />
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
    await user.click(screen.getByRole('textbox'));

    expect(
      screen.queryByRole('button', { name: '创建 PPT' })
    ).not.toBeInTheDocument();
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox').textContent).toBe('保留我的开场。');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
