import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentManagementView, AgentPreflightView } from 'shared/types';

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
      detail: '版本 1.0.0',
      repairable: false,
    },
    {
      id: 'acp',
      label: 'ACP 适配器',
      status: 'fail',
      detail: '未通过 ACP 探测。',
      repairable: true,
    },
  ],
};

describe('AgentDetail', () => {
  it('renders state-driven repair and preflight actions without a detail banner', async () => {
    const onRepair = vi.fn();
    const onPreflight = vi.fn();
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
        onRepair={onRepair}
        onCheckUpdate={vi.fn()}
        onApplyUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    expect(screen.getByText('已通过 API Key 登录')).toBeInTheDocument();
    expect(screen.getByText('本地 Runtime')).toBeInTheDocument();
    expect(screen.getByText('ACP 适配器')).toBeInTheDocument();
    expect(screen.queryByText('安装管理')).not.toBeInTheDocument();
    expect(screen.queryByText('登录状态')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '立即检查' }));
    await userEvent.click(screen.getByRole('button', { name: '修复安装' }));
    expect(onPreflight).toHaveBeenCalled();
    expect(onRepair).toHaveBeenCalled();
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
        }}
        preflight={null}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onMove={vi.fn()}
        onPreflight={vi.fn()}
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

    await userEvent.click(screen.getByRole('button', { name: '取消操作' }));
    expect(onCancelOperation).toHaveBeenCalledOnce();
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
