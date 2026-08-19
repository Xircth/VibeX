import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { BackendTransport } from '@/lib/backendTransport';
import {
  PluginActionEditor,
  type PluginActionDraft,
} from './PluginActionEditor';

const presentationAction = {
  pluginId: 'vibex.office',
  actionId: 'create-presentation',
  label: '创建 PPT',
  requiredSkills: ['office-pptx'],
  requiredTools: ['officecli'],
  promptBlocks: [
    {
      type: 'text' as const,
      text: '澄清受众与目标后，创建新的 PPTX 并验证输出。',
    },
  ],
  artifactIntent: {
    mediaTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    provider: 'officecli',
  },
};

afterEach(async () => {
  cleanup();
  if (i18n.language !== 'zh-CN') {
    await i18n.changeLanguage('zh-CN');
  }
});

describe('PluginActionEditor', () => {
  it('keeps a restored action blocked until its catalog readiness loads', () => {
    const onReadyChange = vi.fn();
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(
        () =>
          new Promise(() => {
            // Intentionally pending: restored actions must fail closed.
          })
      ),
    };

    render(
      <PluginActionEditor
        transport={transport}
        value={presentationAction}
        onChange={() => {}}
        onReadyChange={onReadyChange}
      />
    );

    expect(onReadyChange).toHaveBeenLastCalledWith(false);
  });

  it('inserts an editable action prompt without sending it', async () => {
    const user = userEvent.setup();
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        return { actions: [presentationAction] };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    function Harness() {
      const [draft, setDraft] = useState<PluginActionDraft | null>(null);
      return (
        <PluginActionEditor
          transport={transport}
          value={draft}
          onChange={setDraft}
        />
      );
    }

    render(<Harness />);
    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));

    const prompt = screen.getByRole('textbox', { name: '动作提示词' });
    expect(prompt).toHaveValue('澄清受众与目标后，创建新的 PPTX 并验证输出。');

    await user.type(prompt, ' 面向设计团队。');
    expect(prompt).toHaveValue(
      '澄清受众与目标后，创建新的 PPTX 并验证输出。 面向设计团队。'
    );
    expect(call).toHaveBeenCalledWith('plugin_action_catalog');
  });

  it('keeps the original action editable while a missing tool installs', async () => {
    const user = userEvent.setup();
    const onReadyChange = vi.fn();
    let finishInstall: (() => void) | undefined;
    let catalogRequests = 0;
    const install = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        catalogRequests += 1;
        return {
          actions: [presentationAction],
          readiness: {
            enabled: true,
            dependency: {
              id: 'officecli',
              status: catalogRequests === 1 ? 'missing' : 'ready',
            },
            skills: [
              {
                id: 'office-pptx',
                status: catalogRequests === 1 ? 'missing' : 'ready',
              },
            ],
            providers: [
              {
                id: 'officecli',
                status: catalogRequests === 1 ? 'unavailable' : 'ready',
              },
            ],
            overall: catalogRequests === 1 ? 'not_ready' : 'ready',
          },
        };
      }
      if (command === 'plugin_control_install_runtime') {
        await install;
        return { installed: true, version: '1.0.140' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    function Harness() {
      const [draft, setDraft] = useState<PluginActionDraft | null>(null);
      return (
        <PluginActionEditor
          transport={transport}
          value={draft}
          onChange={setDraft}
          onReadyChange={onReadyChange}
        />
      );
    }

    render(<Harness />);
    const actionButton = await screen.findByRole('button', {
      name: '创建 PPT',
    });
    await user.click(actionButton);

    expect(
      screen.getByRole('status', { name: 'OfficeCLI 安装进度' })
    ).toHaveTextContent('正在安装 OfficeCLI');
    expect(actionButton).toBeDisabled();
    await user.click(actionButton);
    const prompt = screen.getByRole('textbox', { name: '动作提示词' });
    await user.type(prompt, ' 面向客户。');

    finishInstall?.();
    expect(
      await screen.findByDisplayValue(
        '澄清受众与目标后，创建新的 PPTX 并验证输出。 面向客户。'
      )
    ).toBe(prompt);
    expect(
      screen.queryByRole('status', { name: 'OfficeCLI 安装进度' })
    ).not.toBeInTheDocument();
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
    expect(call).toHaveBeenCalledWith('plugin_action_catalog');
  });

  it('keeps the public ready gate closed while a skill or provider is unavailable', async () => {
    const user = userEvent.setup();
    const onReadyChange = vi.fn();
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async () => ({
        actions: [presentationAction],
        readiness: {
          enabled: true,
          dependency: { id: 'officecli', status: 'ready' },
          skills: [{ id: 'office-pptx', status: 'ready' }],
          providers: [{ id: 'officecli', status: 'unavailable' }],
          overall: 'not_ready',
        },
      })),
    };

    function Harness() {
      const [draft, setDraft] = useState<PluginActionDraft | null>(null);
      return (
        <PluginActionEditor
          transport={transport}
          value={draft}
          onChange={setDraft}
          onReadyChange={onReadyChange}
        />
      );
    }

    render(<Harness />);
    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));

    expect(onReadyChange).toHaveBeenLastCalledWith(false);
  });

  it('preserves user input and shows an actionable diagnostic when install fails', async () => {
    const user = userEvent.setup();
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        return {
          actions: [presentationAction],
          readiness: {
            enabled: true,
            dependency: { id: 'officecli', status: 'missing' },
          },
        };
      }
      if (command === 'plugin_control_install_runtime') {
        throw new Error('HASH_MISMATCH: downloaded OfficeCLI was rejected');
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    function Harness() {
      const [draft, setDraft] = useState<PluginActionDraft | null>(null);
      return (
        <PluginActionEditor
          transport={transport}
          value={draft}
          onChange={setDraft}
        />
      );
    }

    render(<Harness />);
    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));
    const prompt = screen.getByRole('textbox', { name: '动作提示词' });
    await user.type(prompt, ' 保留这一句。');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'HASH_MISMATCH: downloaded OfficeCLI was rejected'
    );
    expect(
      screen.getByRole('button', { name: '重试安装 OfficeCLI' })
    ).toBeEnabled();
    expect(prompt).toHaveValue(
      '澄清受众与目标后，创建新的 PPTX 并验证输出。 保留这一句。'
    );
  });

  it('shows skill, tool, and artifact intent as separate action chips', async () => {
    const user = userEvent.setup();
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') {
        return {
          actions: [presentationAction],
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

    function Harness() {
      const [draft, setDraft] = useState<PluginActionDraft | null>(null);
      return (
        <PluginActionEditor
          transport={transport}
          value={draft}
          onChange={setDraft}
        />
      );
    }

    render(<Harness />);
    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));

    expect(screen.getByText('Skill · office-pptx')).toBeVisible();
    expect(screen.getByText('Tool · officecli')).toBeVisible();
    expect(screen.getByText('Artifact · PPTX')).toBeVisible();
  });

  it('cancels the active install with the keyboard and keeps the action draft', async () => {
    const user = userEvent.setup();
    let finishInstall: (() => void) | undefined;
    const install = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const call = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'plugin_action_catalog') {
          return {
            actions: [presentationAction],
            readiness: {
              enabled: true,
              dependency: { id: 'officecli', status: 'missing' },
            },
          };
        }
        if (command === 'plugin_control_install_runtime') {
          expect(args).toMatchObject({
            pluginId: 'vibex.office',
            runtimeId: 'officecli',
          });
          await install;
          return { installed: false };
        }
        throw new Error(`unexpected command: ${command}`);
      }
    );
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    function Harness() {
      const [draft, setDraft] = useState<PluginActionDraft | null>(null);
      return (
        <PluginActionEditor
          transport={transport}
          value={draft}
          onChange={setDraft}
        />
      );
    }

    render(<Harness />);
    await user.click(await screen.findByRole('button', { name: '创建 PPT' }));

    const cancel = screen.getByRole('button', {
      name: '取消安装 OfficeCLI',
    });
    cancel.focus();
    await user.keyboard('{Enter}');

    expect(call).toHaveBeenCalledWith('plugin_control_install_runtime', {
      pluginId: 'vibex.office',
      runtimeId: 'officecli',
    });
    finishInstall?.();
    expect(screen.getByRole('textbox', { name: '动作提示词' })).toHaveValue(
      '澄清受众与目标后，创建新的 PPTX 并验证输出。'
    );
  });

  it('shows loading, recoverable failure, and empty catalog states', async () => {
    const user = userEvent.setup();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValue({ actions: [] });
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    render(
      <PluginActionEditor
        transport={transport}
        value={null}
        onChange={() => {}}
      />
    );

    expect(
      screen.getByRole('status', { name: 'Plugin actions 加载状态' })
    ).toHaveTextContent('正在加载 Office 快捷工作流');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'catalog unavailable'
    );

    await user.click(
      screen.getByRole('button', { name: '重试加载快捷工作流' })
    );
    expect(
      await screen.findByText('暂无可用的 Office 快捷工作流')
    ).toBeVisible();
  });

  it('localizes Office action names and accessible progress text in English', async () => {
    await i18n.changeLanguage('en');
    const call = vi.fn(async () => ({
      actions: [presentationAction],
      readiness: {
        enabled: true,
        dependency: { id: 'officecli', status: 'ready' },
      },
    }));
    const transport: BackendTransport = {
      environment: 'desktop',
      call,
    };

    render(
      <PluginActionEditor
        transport={transport}
        value={null}
        onChange={() => {}}
      />
    );

    expect(
      await screen.findByRole('button', { name: 'Create presentation' })
    ).toBeVisible();
  });
});
