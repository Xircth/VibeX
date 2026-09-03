import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
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
      id: 'acp',
      label: 'ACP 适配器',
      status: 'pass',
      detail: '',
      version: '1.1.0',
      path: '/opt/vibex/bin/codex-acp',
      source: null,
      repairable: true,
      update_available: false,
      available_version: null,
      update_group: null,
    },
    {
      id: 'dependency.node',
      label: 'Node.js',
      status: 'warning',
      detail: '当前版本不满足 >=22。',
      version: 'v20.18.0',
      path: '/usr/local/bin/node',
      source: 'system',
      repairable: false,
      update_available: false,
      available_version: null,
      update_group: null,
    },
  ],
};

describe('AgentDetail', () => {
  it('keeps the version row on the same grid line while details expand', async () => {
    const stylesheet = readFileSync(
      resolve(process.cwd(), 'src/styles/legacy/index.css'),
      'utf8'
    );
    const relevantRules: string[] = [];
    parse(stylesheet).walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && rule.parent.name === 'container') {
        return;
      }
      if (
        rule.selector.includes(
          "button:not([role='switch']):not([role='checkbox'])"
        ) ||
        rule.selector === '.settings-page .agent-preflight-layout' ||
        rule.selector.includes("data-expanded='true'") ||
        rule.selector === '.settings-page .agent-preflight-trigger' ||
        rule.selector === '.settings-page .agent-preflight-identity' ||
        rule.selector === '.settings-page .agent-preflight-identity strong' ||
        rule.selector === '.settings-page .agent-preflight-information-list' ||
        rule.selector === '.settings-page .agent-preflight-information' ||
        rule.selector === '.settings-page .agent-preflight-information-label' ||
        rule.selector === '.settings-page .agent-preflight-evidence-value'
      ) {
        relevantRules.push(rule.toString());
      }
    });
    const style = document.createElement('style');
    style.textContent = relevantRules.join('\n');
    document.head.append(style);

    const rendered = render(
      <div className="settings-page">
        <AgentDetail
          agent={agent}
          operation={null}
          preflight={preflight}
          checking={false}
          checkingUpdate={false}
          updateCheck={null}
          onSetEnabled={vi.fn()}
          onPreflight={vi.fn()}
          onInstall={vi.fn()}
          onRepair={vi.fn()}
          onCheckUpdate={vi.fn()}
          onRollback={vi.fn()}
          onCancelOperation={vi.fn()}
          onUninstall={vi.fn()}
          onRemove={vi.fn()}
          onExportDiagnostics={vi.fn()}
        />
      </div>
    );

    try {
      const runtimeResult = screen.getByRole('listitem', {
        name: 'ACP 适配器 检查结果',
      });
      const runtimeToggle = runtimeResult.querySelector(
        '.agent-preflight-trigger'
      );
      const layout = runtimeResult.querySelector('.agent-preflight-layout');
      expect(layout).not.toBeNull();
      expect(runtimeToggle).not.toBeNull();
      expect(getComputedStyle(layout!).minHeight).toBe('52px');
      expect(getComputedStyle(layout!).alignItems).toBe('center');
      expect(getComputedStyle(runtimeToggle!).alignSelf).toBe('center');
      expect(getComputedStyle(layout!).gridTemplateColumns).toBe(
        '160px minmax(0, 1fr) auto'
      );
      expect(
        getComputedStyle(screen.getByRole('button', { name: '检查更新' }))
          .minHeight
      ).toBe('2rem');
      expect(
        getComputedStyle(screen.getByText('ACP 适配器')).overflowWrap
      ).toBe('anywhere');
      expect(
        getComputedStyle(within(runtimeResult).getByTitle('1.1.0')).whiteSpace
      ).toBe('normal');

      const informationStack = within(runtimeResult).getByRole('group', {
        name: 'ACP 适配器 完整检查信息',
      });
      const versionToken = within(informationStack).getByText('版本');
      const versionRow = versionToken.parentElement!;
      expect(getComputedStyle(informationStack).display).toBe('grid');
      expect(getComputedStyle(informationStack).gridTemplateColumns).toBe(
        '1fr'
      );
      expect(getComputedStyle(versionRow).gridTemplateColumns).toBe(
        '64px minmax(0, 1fr)'
      );

      await userEvent.click(
        screen.getByRole('button', { name: '展开 ACP 适配器 的检查详情' })
      );
      expect(getComputedStyle(layout!).alignItems).toBe('start');
      expect(getComputedStyle(runtimeToggle!).alignSelf).toBe('start');
      expect(getComputedStyle(layout!).gridTemplateColumns).toBe(
        '160px minmax(0, 1fr) auto'
      );
      expect(within(runtimeResult).getByText('版本')).toBe(versionToken);
      expect(
        getComputedStyle(
          within(runtimeResult).getByText('ACP 适配器').parentElement!
        ).alignSelf
      ).toBe('stretch');

      const informationRows = Array.from(informationStack.children);
      expect(
        within(informationStack)
          .getAllByRole('term')
          .map((term) => term.textContent)
      ).toEqual(['版本', '位置']);
      for (const informationRow of informationRows) {
        expect(getComputedStyle(informationRow).width).toBe('100%');
        expect(getComputedStyle(informationRow).gridTemplateColumns).toBe(
          '64px minmax(0, 1fr)'
        );
      }
    } finally {
      rendered.unmount();
      style.remove();
    }
  });

  it('does not treat a vendor CLI as a preflight health item', () => {
    render(
      <AgentDetail
        agent={{
          ...agent,
          runtime_version: null,
          acp_version: null,
          local_runtime: {
            path: 'C:\\Users\\developer\\AppData\\Roaming\\npm\\codex.cmd',
            version: 'codex-cli 0.138.0',
          },
        }}
        operation={null}
        preflight={null}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    expect(
      screen.queryByRole('listitem', { name: '本地 Runtime 检查结果' })
    ).toBeNull();
    expect(
      within(
        screen.getByRole('listitem', { name: 'ACP 适配器 检查结果' })
      ).getByText('需处理')
    ).toBeInTheDocument();
  });

  it('does not show a local Runtime row when only the ACP adapter is present', () => {
    render(
      <AgentDetail
        agent={{
          ...agent,
          runtime_version: null,
          acp_version: '1.7.0',
          local_runtime: undefined,
        }}
        operation={null}
        preflight={null}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    expect(
      screen.queryByRole('listitem', { name: '本地 Runtime 检查结果' })
    ).toBeNull();
    expect(
      within(
        screen.getByRole('listitem', { name: 'ACP 适配器 检查结果' })
      ).getByText('可用')
    ).toBeInTheDocument();
  });

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
        onPreflight={onPreflight}
        onInstall={vi.fn()}
        onRepair={onRepair}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onEnvironmentDiagnostics={onEnvironmentDiagnostics}
      />
    );

    expect(screen.getByText('已通过 API Key 登录')).toBeInTheDocument();
    expect(screen.queryByText('本地 Runtime')).not.toBeInTheDocument();
    expect(screen.getByText('ACP 适配器')).toBeInTheDocument();
    expect(screen.getByText('Node.js')).toBeInTheDocument();
    const nodeResult = screen.getByRole('listitem', {
      name: 'Node.js 检查结果',
    });
    expect(within(nodeResult).getByText('可选提醒')).toBeInTheDocument();
    expect(within(nodeResult).queryByText('来源')).not.toBeInTheDocument();
    expect(
      within(nodeResult).queryByText('当前版本不满足 >=22。')
    ).not.toBeInTheDocument();

    const acpResult = screen.getByRole('listitem', {
      name: 'ACP 适配器 检查结果',
    });
    expect(within(acpResult).getByTitle('1.1.0')).toHaveClass(
      'agent-preflight-evidence-value'
    );
    expect(
      within(acpResult).queryByTitle('/opt/vibex/bin/codex-acp')
    ).not.toBeInTheDocument();
    const acpToggle = within(acpResult).getByRole('button', {
      name: '展开 ACP 适配器 的检查详情',
    });
    expect(acpToggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(acpToggle);
    expect(acpToggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(acpResult).getByText('位置')).toBeInTheDocument();
    expect(
      within(acpResult).getByTitle('/opt/vibex/bin/codex-acp')
    ).toHaveClass('agent-preflight-evidence-value');

    await userEvent.click(
      within(nodeResult).getByRole('button', {
        name: '展开 Node.js 的检查详情',
      })
    );
    expect(within(nodeResult).getByText('来源')).toBeInTheDocument();
    expect(within(nodeResult).getByText('本机环境')).toBeInTheDocument();
    expect(
      within(nodeResult).getByText('当前版本不满足 >=22。')
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

  it('groups expanded preflight evidence into one accessible information stack', async () => {
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    const nodeResult = screen.getByRole('listitem', {
      name: 'Node.js 检查结果',
    });
    await userEvent.click(
      within(nodeResult).getByRole('button', {
        name: '展开 Node.js 的检查详情',
      })
    );

    const informationStack = within(nodeResult).getByRole('group', {
      name: 'Node.js 完整检查信息',
    });
    expect(
      within(informationStack)
        .getAllByRole('term')
        .map((term) => term.textContent)
    ).toEqual(['版本', '来源', '位置', '检查说明']);
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
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
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
          message: '正在安装 ACP',
          logs: [
            '正在解析已锁定的安装方案',
            '$ npm install -g @openai/codex@1.0.0',
          ],
        }}
        preflight={null}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={onCancelOperation}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    const progress = screen.getByRole('progressbar', {
      name: '正在安装 ACP',
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
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onInstallVersion={onInstallVersion}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    await userEvent.click(screen.getByText('指定版本安装'));
    const versionInput = screen.getByLabelText('版本');
    const submit = screen.getByRole('button', { name: '安装此版本' });
    await userEvent.type(versionInput, 'latest');
    expect(submit).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('具体的点分版本号');
    await userEvent.clear(versionInput);
    await userEvent.type(versionInput, 'v1.7.0');
    await userEvent.click(submit);

    expect(onInstallVersion).toHaveBeenCalledWith({
      acpVersion: 'v1.7.0',
    });
  });

  it('previews a specified ACP version without requiring a vendor CLI pin', async () => {
    const onInstallVersion = vi.fn();
    const onPreviewVersions = vi.fn().mockResolvedValue(null);
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        checking={false}
        checkingUpdate={false}
        updateCheck={{
          agent_id: 'codex',
          current_version: '1.5.0',
          available_version: '1.7.0',
          update_available: true,
          runtime_current: null,
          runtime_available: null,
          acp_current: '1.5.0',
          acp_available: '1.7.0',
          compatibility_warning: null,
          snapshot_id: null,
          fetched_at: null,
          fresh: true,
        }}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onInstallVersion={onInstallVersion}
        onPreviewVersions={onPreviewVersions}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    await userEvent.click(screen.getByText('指定版本安装'));
    await userEvent.type(screen.getByLabelText('版本'), '1.7.0');
    const submit = screen.getByRole('button', { name: '安装此版本' });
    expect(submit).toBeEnabled();
    await waitFor(() =>
      expect(onPreviewVersions).toHaveBeenCalledWith({
        acpVersion: '1.7.0',
      })
    );
    await userEvent.click(submit);
    expect(onInstallVersion).toHaveBeenCalledWith({
      acpVersion: '1.7.0',
    });
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
            message: '正在安装 ACP',
            logs: ['正在解析已锁定的安装方案', '正在安装 ACP'],
          }}
          preflight={preflight}
          checking={false}
          checkingUpdate={false}
          updateCheck={null}
          onSetEnabled={vi.fn()}
          onPreflight={vi.fn()}
          onInstall={vi.fn()}
          onRepair={vi.fn()}
          onCheckUpdate={vi.fn()}
          onRollback={vi.fn()}
          onCancelOperation={vi.fn()}
          onUninstall={vi.fn()}
          onRemove={vi.fn()}
          onExportDiagnostics={vi.fn()}
        />
      );

      expect(
        screen.getByText('Installing ACP…')
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          'Node.js is optional; related capabilities may be unavailable until it is configured.'
        )
      ).not.toBeInTheDocument();
      await userEvent.click(
        screen.getByRole('button', {
          name: 'Expand check details for Node.js',
        })
      );
      expect(
        screen.getByText(
          'Node.js is optional; related capabilities may be unavailable until it is configured.'
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText('Resolving the locked installation plan')
      ).toBeInTheDocument();
      expect(
        screen.getByText('Installing ACP')
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
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={onCheckUpdate}
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

  it('keeps update install on the preflight row instead of a separate banner', async () => {
    const onCheckUpdate = vi.fn();
    const onUpdatePreflightItem = vi.fn();
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={{
          ...preflight,
          items: preflight.items.map((item) =>
            item.id === 'acp'
              ? {
                  ...item,
                  update_available: true,
                  available_version: '1.7.0',
                }
              : item
          ),
        }}
        checking={false}
        checkingUpdate={false}
        updateCheck={{
          agent_id: agent.agent_id,
          current_version: '1.1.9',
          available_version: '1.7.0',
          update_available: true,
          snapshot_id: 'snapshot-1',
          fetched_at: '2026-07-30T00:00:00Z',
          fresh: false,
        }}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={onCheckUpdate}
        onUpdatePreflightItem={onUpdatePreflightItem}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(onCheckUpdate).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', { name: '安装更新' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/可更新：/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '可更新' }));
    expect(onUpdatePreflightItem).toHaveBeenCalledWith('acp');
  });

  it('starts a preflight item update from the available status', async () => {
    const onUpdatePreflightItem = vi.fn();
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={{
          ...preflight,
          items: preflight.items.map((item) =>
            item.id === 'acp'
              ? {
                  ...item,
                  update_available: true,
                  available_version: '1.2.0',
                }
              : item
          ),
        }}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onUpdatePreflightItem={onUpdatePreflightItem}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />
    );

    expect(
      screen.queryByRole('button', { name: '更新' })
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '可更新' }));
    expect(onUpdatePreflightItem).toHaveBeenCalledWith('acp');
  });

  it('marks all diagnostics read and highlights unread entries', async () => {
    const onMarkAllDiagnosticsRead = vi.fn();
    const diagnostics = [
      {
        id: 'diag-1',
        agent_id: 'codex',
        operation_kind: 'launch_gate',
        severity: 'error',
        message: '启动前完整性验证失败',
        redacted_output: 'locked component failed verification',
        created_at: '2026-08-05T16:47:30Z',
        read: false,
      },
      {
        id: 'diag-2',
        agent_id: 'codex',
        operation_kind: 'install',
        severity: 'info',
        message: '安装完成',
        redacted_output: null,
        created_at: '2026-08-05T13:00:00Z',
        read: true,
      },
    ];
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        diagnostics={diagnostics}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onMarkAllDiagnosticsRead={onMarkAllDiagnosticsRead}
      />
    );

    expect(screen.getByText('操作诊断 · 2')).toBeInTheDocument();
    expect(screen.getByText('1 条未读')).toBeInTheDocument();
    const unreadEntry = screen.getByText('启动前完整性验证失败');
    expect(unreadEntry.closest('li')).toHaveClass('bg-primary/5');
    // 展开内容不再带顶部边框线。
    const list = unreadEntry.closest('ul');
    expect(list).not.toHaveClass('border-t');

    await userEvent.click(screen.getByRole('button', { name: '全部已读' }));
    expect(onMarkAllDiagnosticsRead).toHaveBeenCalledOnce();
  });

  it('opens operation diagnostics when arriving from a session-creation jump', () => {
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        diagnostics={[
          {
            id: 'diag-1',
            agent_id: 'codex',
            operation_kind: 'install',
            severity: 'error',
            message: 'Agent 安装或验证失败',
            redacted_output: 'npm error code ECONNREFUSED',
            created_at: '2026-09-02T03:11:46Z',
            read: false,
          },
        ]}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
        focusDiagnostics
      />
    );

    const panel = screen.getByText('操作诊断 · 1').closest('details');
    expect(panel).toHaveAttribute('open');
    expect(screen.getByText('npm error code ECONNREFUSED')).toBeVisible();
  });

  it('hides the diagnostic list when operation diagnostics are disabled', async () => {
    const diagnostics = [
      {
        id: 'diag-1',
        agent_id: 'codex',
        operation_kind: 'launch_gate',
        severity: 'error',
        message: '启动前完整性验证失败',
        redacted_output: null,
        created_at: '2026-08-05T16:47:30Z',
        read: false,
      },
    ];
    render(
      <AgentDetail
        agent={agent}
        operation={null}
        preflight={preflight}
        diagnostics={diagnostics}
        checking={false}
        checkingUpdate={false}
        updateCheck={null}
        onSetEnabled={vi.fn()}
        onPreflight={vi.fn()}
        onInstall={vi.fn()}
        onRepair={vi.fn()}
        onCheckUpdate={vi.fn()}
        onRollback={vi.fn()}
        onCancelOperation={vi.fn()}
        onUninstall={vi.fn()}
        onRemove={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onMarkAllDiagnosticsRead={vi.fn()}
      />
    );

    const toggle = screen.getByRole('switch', {
      name: '显示操作诊断',
    });
    expect(toggle).toBeChecked();
    expect(screen.getByText('启动前完整性验证失败')).toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).not.toBeChecked();
    expect(screen.queryByText('启动前完整性验证失败')).not.toBeInTheDocument();
    expect(localStorage.getItem('vibex:operation-diagnostics')).toBe('off');
  });
});
