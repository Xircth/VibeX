import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
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
    call: vi.fn(),
    capabilities: vi.fn().mockResolvedValue({
      server_version: 'desktop',
      protocol_version: '1.0',
      minimum_client_version: '0.1.0',
      capabilities: ['plugin.read', 'plugin.write'],
    }),
  };
  render(
    <BackendTransportProvider transport={transport}>
      <PluginConfigForm pluginId={pluginId} detail={detail} onSaved={vi.fn()} />
    </BackendTransportProvider>
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
});
