import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { CodeCompletionStatusPopover } from '@/components/plugins/CodeCompletionStatusPopover';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { BackendTransportProvider } from '@/lib/transport';
import type { BackendTransport } from '@/lib/backendTransport';
import type { PluginProductDetail } from '@/lib/api/plugins';

import { PluginConfigForm } from './PluginConfigForm';

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: { show: vi.fn() },
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const scienceDetail: PluginProductDetail = {
  summary: '146 research Skills in 10 domains.',
  readme: '# Scientific Research',
  contents: [],
  config: { domains: { general: false, literature: true } },
  configSchema: {
    type: 'object',
    properties: {
      domains: {
        type: 'object',
        title: '技能领域',
        description: '按领域启用技能。',
        properties: {
          general: {
            type: 'boolean',
            title: '通用科研方法',
            description: '选题构思、假设、实验设计。默认开启。（13 项技能）',
          },
          literature: {
            type: 'boolean',
            title: '文献检索与信息获取',
            description: '跨学术文献检索可复现证据。（12 项技能）',
          },
        },
      },
    },
  },
};

function renderForm(
  detail: PluginProductDetail = scienceDetail,
  pluginId = 'vibex.science'
) {
  const transport: BackendTransport = {
    environment: 'desktop',
    call: vi.fn(async (_command, args) => ({
      ...detail,
      config:
        args && typeof args === 'object' && 'config' in args
          ? (args as { config: Record<string, unknown> }).config
          : detail.config,
    })),
    capabilities: vi.fn().mockResolvedValue({
      server_version: 'desktop',
      protocol_version: '1.0',
      minimum_client_version: '0.1.0',
      capabilities: ['plugin.read', 'plugin.write'],
    }),
  };
  render(
    <MemoryRouter>
      <BackendTransportProvider transport={transport}>
        <PluginConfigForm
          pluginId={pluginId}
          detail={detail}
          onSaved={vi.fn()}
        />
      </BackendTransportProvider>
    </MemoryRouter>
  );
  return transport;
}

describe('PluginConfigForm', () => {
  beforeEach(() => {
    vi.mocked(ConfirmDialog.show).mockReset();
    vi.mocked(ConfirmDialog.show).mockResolvedValue('confirmed');
  });

  it('asks before enabling a skill-pack domain and keeps it off if cancelled', async () => {
    const user = userEvent.setup();
    vi.mocked(ConfirmDialog.show).mockResolvedValue('canceled');
    renderForm();

    const toggle = screen.getByRole('switch', { name: '通用科研方法' });
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
    await user.click(toggle);

    await waitFor(() => {
      expect(ConfirmDialog.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '通用科研方法',
          message: '该领域技能包一共包含 13 个 Skill，是否确认启用？',
        })
      );
    });
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
  });

  it('enables a skill-pack domain after confirmation', async () => {
    const user = userEvent.setup();
    renderForm();

    const toggle = screen.getByRole('switch', { name: '通用科研方法' });
    await user.click(toggle);

    await waitFor(() => {
      expect(ConfirmDialog.show).toHaveBeenCalled();
      expect(toggle).toHaveAttribute('data-state', 'checked');
    });
  });

  it('does not ask when turning a skill-pack domain off', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(
      screen.getByRole('switch', { name: '文献检索与信息获取' })
    );

    expect(ConfirmDialog.show).not.toHaveBeenCalled();
    expect(
      screen.getByRole('switch', { name: '文献检索与信息获取' })
    ).toHaveAttribute('data-state', 'unchecked');
  });

  it('saves a boolean change immediately without a save bar', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn().mockResolvedValue({
        summary: 'Office',
        readme: '# Office',
        contents: [],
        config: { preview: true },
        configSchema: {
          type: 'object',
          properties: {
            preview: { type: 'boolean', title: 'Document preview' },
          },
        },
      }),
      capabilities: vi.fn().mockResolvedValue({
        server_version: 'desktop',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read', 'plugin.write'],
      }),
    };
    render(
      <MemoryRouter>
        <BackendTransportProvider transport={transport}>
          <PluginConfigForm
            pluginId="vibex.office"
            detail={{
              summary: 'Office',
              readme: '# Office',
              contents: [],
              config: { preview: false },
              configSchema: {
                type: 'object',
                properties: {
                  preview: { type: 'boolean', title: 'Document preview' },
                },
              },
            }}
            onSaved={onSaved}
          />
        </BackendTransportProvider>
      </MemoryRouter>
    );

    await user.click(screen.getByRole('switch', { name: 'Document preview' }));

    await waitFor(() => {
      expect(transport.call).toHaveBeenCalledWith('plugin_save_config', {
        pluginId: 'vibex.office',
        config: { preview: true },
      });
    });
    expect(
      screen.queryByRole('button', { name: /save|保存/i })
    ).not.toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it('does not ask when toggling a boolean that is not a skill pack', async () => {
    const user = userEvent.setup();
    renderForm(
      {
        summary: 'Office',
        readme: '# Office',
        contents: [],
        config: { preview: false },
        configSchema: {
          type: 'object',
          properties: {
            preview: { type: 'boolean', title: 'Document preview' },
          },
        },
      },
      'vibex.office'
    );

    const toggle = screen.getByRole('switch', { name: 'Document preview' });
    await user.click(toggle);

    expect(ConfirmDialog.show).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('data-state', 'checked');
  });

  it('does not save on every keystroke in text inputs and saves once on blur without losing focus', async () => {
    const user = userEvent.setup();
    const transport = renderForm(
      {
        summary: 'Code Completion',
        readme: '# Code Completion',
        contents: [],
        config: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'gpt-4o-mini',
        },
        configSchema: {
          type: 'object',
          properties: {
            baseUrl: { type: 'string', title: 'Base URL' },
            apiKey: { type: 'string', title: 'API Key' },
            model: { type: 'string', title: '补全模型', default: 'gpt-4o-mini' },
          },
        },
      },
      'vibex.code-completion'
    );

    const apiKeyInput = screen.getByLabelText('API Key');
    await user.click(apiKeyInput);
    await user.type(apiKeyInput, 'sk-test-123');

    expect(apiKeyInput).toHaveValue('sk-test-123');
    expect(apiKeyInput).toHaveFocus();
    expect(transport.call).not.toHaveBeenCalledWith(
      'plugin_save_config',
      expect.anything()
    );

    await user.tab();

    await waitFor(() => {
      expect(transport.call).toHaveBeenCalledTimes(1);
      expect(transport.call).toHaveBeenCalledWith('plugin_save_config', {
        pluginId: 'vibex.code-completion',
        config: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test-123',
          model: 'gpt-4o-mini',
        },
      });
    });
  });

  it('fetches models via button and populates the model selector dropdown', async () => {
    const user = userEvent.setup();
    const detail: PluginProductDetail = {
      summary: 'Code Completion',
      readme: '# Code Completion',
      contents: [],
      config: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek',
        model: 'gpt-4o-mini',
      },
      configSchema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', title: 'Base URL' },
          apiKey: { type: 'string', title: 'API Key' },
          model: { type: 'string', title: '补全模型', default: 'gpt-4o-mini' },
        },
      },
    };
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command, args) => {
        if (command === 'dsh_provider_discover_models') {
          return [
            { id: 'deepseek-chat', name: 'DeepSeek Chat' },
            { id: 'deepseek-coder', name: 'DeepSeek Coder' },
          ];
        }
        return {
          ...detail,
          config:
            args && typeof args === 'object' && 'config' in args
              ? (args as { config: Record<string, unknown> }).config
              : detail.config,
        };
      }),
      capabilities: vi.fn().mockResolvedValue({
        server_version: 'desktop',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read', 'plugin.write'],
      }),
    };

    render(
      <MemoryRouter>
        <BackendTransportProvider transport={transport}>
          <PluginConfigForm
            pluginId="vibex.code-completion"
            detail={detail}
            onSaved={vi.fn()}
          />
        </BackendTransportProvider>
      </MemoryRouter>
    );

    const fetchButton = screen.getByRole('button', {
      name: /拉取模型|Fetch models/i,
    });
    await user.click(fetchButton);

    await waitFor(() => {
      expect(transport.call).toHaveBeenCalledWith(
        'dsh_provider_discover_models',
        {
          request: {
            base_url: 'https://api.deepseek.com/v1',
            api_key: 'sk-deepseek',
            provider_id: null,
          },
        }
      );
      expect(transport.call).toHaveBeenCalledWith('plugin_save_config', {
        pluginId: 'vibex.code-completion',
        config: {
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-deepseek',
          model: 'deepseek-chat',
        },
      });
    });
  });

  it('records and saves manualShortcut when clicking Record shortcut button', async () => {
    const user = userEvent.setup();
    const detail: PluginProductDetail = {
      summary: 'Code Completion',
      readme: '# Code Completion',
      contents: [],
      config: {
        manualShortcut: 'Alt+\\',
      },
      configSchema: {
        type: 'object',
        properties: {
          manualShortcut: {
            type: 'string',
            title: '手动补全快捷键',
            default: 'Alt+\\',
          },
        },
      },
    };
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn().mockImplementation(async (command, args) => {
        if (command === 'plugin_save_config') {
          return {
            ...detail,
            config: (args as { config: Record<string, unknown> }).config,
          };
        }
        return detail;
      }),
      capabilities: vi.fn().mockResolvedValue({
        server_version: 'desktop',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read', 'plugin.write'],
      }),
    };

    render(
      <MemoryRouter>
        <BackendTransportProvider transport={transport}>
          <PluginConfigForm
            pluginId="vibex.code-completion"
            detail={detail}
            onSaved={vi.fn()}
          />
        </BackendTransportProvider>
      </MemoryRouter>
    );

    const recordButton = screen.getByRole('button', {
      name: /录制快捷键|Record shortcut/i,
    });
    await user.click(recordButton);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'i',
        code: 'KeyI',
        altKey: true,
        ctrlKey: true,
        bubbles: true,
      })
    );

    await waitFor(() => {
      expect(transport.call).toHaveBeenCalledWith('plugin_save_config', {
        pluginId: 'vibex.code-completion',
        config: {
          manualShortcut: 'Ctrl+Alt+I',
        },
      });
    });
  });

  it('opens CodeCompletionStatusPopover from the status bar icon to toggle enabled, switch model, and record shortcut', async () => {
    const user = userEvent.setup();
    const detail: PluginProductDetail = {
      summary: 'Code Completion',
      readme: '# Code Completion',
      contents: [],
      config: {
        enabled: true,
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        model: 'deepseek-flash',
        triggerMode: 'auto',
        manualShortcut: 'Alt+\\',
      },
      configSchema: {
        type: 'object',
        properties: {},
      },
    };

    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn().mockImplementation(async (command, args) => {
        if (command === 'plugin_product_detail') {
          return detail;
        }
        if (command === 'plugin_save_config') {
          return {
            ...detail,
            config: (args as { config: Record<string, unknown> }).config,
          };
        }
        return {};
      }),
      capabilities: vi.fn().mockResolvedValue({
        server_version: 'desktop',
        protocol_version: '1.0',
        minimum_client_version: '0.1.0',
        capabilities: ['plugin.read', 'plugin.write'],
      }),
    };

    render(
      <MemoryRouter>
        <BackendTransportProvider transport={transport}>
          <CodeCompletionStatusPopover
            icon={contributionIconComponent('sparkles')}
            label="AI代码补全"
          />
        </BackendTransportProvider>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId('code-completion-status-trigger'));

    const switchEl = await screen.findByRole('switch');
    await user.click(switchEl);

    await waitFor(() => {
      expect(transport.call).toHaveBeenCalledWith(
        'plugin_save_config',
        expect.objectContaining({
          pluginId: 'vibex.code-completion',
          config: expect.objectContaining({
            enabled: false,
          }),
        })
      );
    });
  });
});


