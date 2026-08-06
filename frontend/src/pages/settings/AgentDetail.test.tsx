import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentManagementView, AgentPreflightView } from 'shared/types';

import i18n from '@/i18n';

import { AgentDetail } from './AgentDetail';

const agent: AgentManagementView = {
  agent_id: 'codex',
  display_name: 'Codex',
  description: 'Codex ACP',
  icon_light: null,
  icon_dark: null,
  icon_svg: null,
  source: 'built_in_profile',
  built_in: true,
  retired: false,
  enabled: true,
  position: 1,
  lifecycle: 'needs_repair',
  authentication: 'api_key',
  runtime_version: '1.0.0',
  acp_version: null,
  active_operation: null,
  rollback_available: false,
};

const preflight: AgentPreflightView = {
  agent_id: 'codex',
  checked_at: '2026-07-29T12:00:00Z',
  items: [
    {
      id: 'runtime',
      label: '本地 Runtime',
      status: 'pass',
      detail: '',
      version: '1.0.0',
      path: '/opt/vibex/bin/codex',
      repairable: false,
    },
    {
      id: 'acp',
      label: 'ACP 适配器',
      status: 'pass',
      detail: '',
      version: '1.1.0',
      path: '/opt/vibex/bin/codex-acp',
      repairable: true,
    },
    {
      id: 'dependency.node',
      label: 'Node.js',
      status: 'warning',
      detail: '当前版本不满足 >=22。',
      version: 'v20.18.0',
      path: '/usr/local/bin/node',
      repairable: false,
    },
  ],
};

describe('AgentDetail', () => {
  it('renders state-driven repair and preflight actions without a detail banner', async () => {
    const onRepair = vi.fn();
    const onPreflight = vi.fn();
    const onEnvironmentDiagnostics = vi.fn();
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onMove={vi.fn()}
        onPreflight={onPreflight}
        onInstall={vi.fn()}
        onRepair={onRepair}
        onCheckUpdate={vi.fn()}
        onApplyUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onEnvironmentDiagnostics={onEnvironmentDiagnostics}
      />
    );

    expect(screen.getByText('已通过 API Key 登录')).toBeInTheDocument();
    expect(screen.getByText('本地 Runtime')).toBeInTheDocument();
    expect(screen.getByText('ACP 适配器')).toBeInTheDocument();
    expect(screen.getByText('Node.js')).toBeInTheDocument();
    const nodeResult = screen.getByRole('listitem', {
      name: 'Node.js 检查结果',
    });
    expect(within(nodeResult).getByText('可选提醒')).toBeInTheDocument();
    expect(
      within(nodeResult).getByText('当前版本不满足 >=22。')
    ).toBeInTheDocument();
    const runtimeResult = screen.getByRole('listitem', {
      name: '本地 Runtime 检查结果',
    });
    expect(within(runtimeResult).getByText('版本')).toBeInTheDocument();
    expect(within(runtimeResult).getByText('位置')).toBeInTheDocument();
    expect(within(runtimeResult).getByTitle('1.0.0')).toHaveClass(
      'agent-preflight-evidence-value'
    );
    expect(
      within(runtimeResult).getByTitle('/opt/vibex/bin/codex')
    ).toHaveClass('agent-preflight-evidence-value');

    const acpResult = screen.getByRole('listitem', {
      name: 'ACP 适配器 检查结果',
    });
    expect(within(acpResult).getByTitle('1.1.0')).toBeInTheDocument();
    expect(
      within(acpResult).getByTitle('/opt/vibex/bin/codex-acp')
    ).toBeInTheDocument();
    expect(screen.queryByText(/握手成功/)).not.toBeInTheDocument();
    expect(screen.queryByText('安装管理')).not.toBeInTheDocument();
    expect(screen.queryByText('登录状态')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '立即检查' }));
    await userEvent.click(screen.getByRole('button', { name: '环境诊断' }));
    await userEvent.click(screen.getByRole('button', { name: '修复安装' }));
    expect(onPreflight).toHaveBeenCalled();
    expect(onEnvironmentDiagnostics).toHaveBeenCalled();
    expect(onRepair).toHaveBeenCalled();
  });

  it('places the composed authentication manager before preflight', () => {
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        authentication={<section aria-label="鉴权管理">鉴权内容</section>}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onMove={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onApplyUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    const authentication = screen.getByRole('region', { name: '鉴权管理' });
    const preflightRegion = screen.getByRole('region', { name: '预检查' });
    expect(
      authentication.compareDocumentPosition(preflightRegion) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('offers explicit cancellation while an installation operation is running', async () => {
    const onCancelOperation = vi.fn();
    render(
      <AgentDetail
        agent={{ ...agent, active_operation: 'install' }}
        operation={{
          sequence: 1,
          operationId: 'operation-1',
          kind: 'install',
          status: 'running',
          progressPercent: 25,
          message: '正在安装本地 Runtime 与 ACP',
          logs: [
            '正在解析已锁定的安装方案',
            '$ npm install --prefix <managed> @openai/codex@1.0.0',
          ],
        }}
        preflight={null}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onMove={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onApplyUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={onCancelOperation}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    const progress = screen.getByRole('progressbar', {
      name: '正在安装本地 Runtime 与 ACP',
    });
    expect(progress).toHaveAttribute('aria-valuenow', '25');
    expect(progress).toHaveAttribute('aria-valuetext', '安装 · 25%');
    expect(screen.getByText('准备')).toHaveAttribute('data-state', 'complete');
    expect(screen.getByText('安装')).toHaveAttribute('data-state', 'current');
    expect(screen.getByText('验证')).toHaveAttribute('data-state', 'upcoming');
    expect(screen.getByText('完成')).toHaveAttribute('data-state', 'upcoming');
    expect(screen.getByRole('log', { name: '安装日志' })).toHaveTextContent(
      '@openai/codex@1.0.0'
    );
    await userEvent.click(screen.getByRole('button', { name: '取消操作' }));
    expect(onCancelOperation).toHaveBeenCalledOnce();
  });

  it('validates and submits a concrete custom version for supported built-ins', async () => {
    const onInstallVersion = vi.fn();
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onMove={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onInstallVersion={onInstallVersion}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onApplyUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    await userEvent.click(screen.getByText('指定版本安装'));
    const input = screen.getByLabelText('版本');
    const submit = screen.getByRole('button', { name: '安装此版本' });
    await userEvent.type(input, 'latest');
    expect(submit).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('具体的点分版本号');
    await userEvent.clear(input);
    await userEvent.type(input, 'v2.1.0-beta.1');
    await userEvent.click(submit);

    expect(onInstallVersion).toHaveBeenCalledWith('v2.1.0-beta.1');
  });

  it('uses stable English semantics instead of backend Chinese messages', async () => {
    await i18n.changeLanguage('en');
    let rendered: ReturnType<typeof render> | null = null;
    try {
      rendered = render(
        <AgentDetail
          agent={{ ...agent, active_operation: 'install' }}
          operation={{
            sequence: 2,
            operationId: 'operation-english',
            kind: 'install',
            status: 'running',
            progressPercent: 25,
            message: '正在安装本地 Runtime 与 ACP',
            logs: ['正在解析已锁定的安装方案', '正在安装本地 Runtime 与 ACP'],
          }}
          preflight={preflight}
          checking={false}
          checkingUpdate={false}
          updateCheck={null}
          onSetEnabled={vi.fn()}
          onMove={vi.fn()}
          onPreflight={vi.fn()}
          onInstall={vi.fn()}
          onRepair={vi.fn()}
          onCheckUpdate={vi.fn()}
          onApplyUpdate={vi.fn()}
          onRollback={vi.fn()}
          onCancelOperation={vi.fn()}
          onUninstall={vi.fn()}
          onRemove={vi.fn()}
          onExportDiagnostics={vi.fn()}
        />
      );

      expect(
        screen.getByText('Installing the Agent runtime and ACP adapter…')
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Node.js is optional; related capabilities may be unavailable until it is configured.'
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText('Resolving the locked installation plan')
      ).toBeInTheDocument();
      expect(
        screen.getByText('Installing the local runtime and ACP adapter')
      ).toBeInTheDocument();
      expect(screen.queryByText(/正在安装|当前版本/u)).not.toBeInTheDocument();
    } finally {
      rendered?.unmount();
      await i18n.changeLanguage('zh-CN');
    }
  });

  it('keeps update, uninstall, and remove together beside the enable control', async () => {
    const onExportDiagnostics = vi.fn();
    const onCheckUpdate = vi.fn();
    const onUninstall = vi.fn();
    const onRemove = vi.fn();
    render(
      <AgentDetail
        agent={{
          ...agent,
          source: 'official_registry',
          built_in: false,
        }}
        operation={null}
        preflight={preflight}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onMove={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={onCheckUpdate}
        onApplyUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={onUninstall}
        onRemove={onRemove}
        onExportDiagnostics={onExportDiagnostics}
      />
    );

    const header = screen.getByRole('banner');
    const preflightRegion = screen.getByRole('region', { name: '预检查' });
    const enable = within(header).getByRole('switch', { name: '启用 Agent' });
    const update = within(header).getByRole('button', { name: '检查更新' });
    const uninstall = within(header).getByRole('button', { name: '卸载' });
    const remove = within(header).getByRole('button', { name: '移除' });
    expect(
      enable.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      update.compareDocumentPosition(uninstall) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      uninstall.compareDocumentPosition(remove) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      within(preflightRegion).queryByRole('button', { name: '检查更新' })
    ).not.toBeInTheDocument();
    expect(
      within(preflightRegion).queryByRole('button', { name: '卸载' })
    ).not.toBeInTheDocument();
    expect(
      within(preflightRegion).queryByRole('button', { name: '移除' })
    ).not.toBeInTheDocument();

    await userEvent.click(update);
    await userEvent.click(uninstall);
    await userEvent.click(remove);
    await userEvent.click(screen.getByRole('button', { name: '导出诊断记录' }));
    expect(onCheckUpdate).toHaveBeenCalledOnce();
    expect(onUninstall).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onExportDiagnostics).toHaveBeenCalledOnce();
  });

  it('requires an explicit second action before applying an available update', async () => {
    const onCheckUpdate = vi.fn();
    const onApplyUpdate = vi.fn();
    const { rerender } = render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onMove={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={onCheckUpdate}
        onApplyUpdate={onApplyUpdate}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(onCheckUpdate).toHaveBeenCalledOnce();
    expect(onApplyUpdate).not.toHaveBeenCalled();

    rerender(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        checking={false}
        checkingUpdate={false}
        updateCheck={{
          agent_id: agent.agent_id,
          current_version: '1.0.0',
          available_version: '1.1.0',
          update_available: true,
          snapshot_id: 'snapshot-1',
          fetched_at: '2026-07-30T00:00:00Z',
          fresh: true,
        }}
        onSetEnabled={vi.fn()}
        onMove={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={onCheckUpdate}
        onApplyUpdate={onApplyUpdate}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    expect(screen.getByText('可更新：1.0.0 → 1.1.0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '安装更新' }));
    expect(onApplyUpdate).toHaveBeenCalledOnce();
  });
});
