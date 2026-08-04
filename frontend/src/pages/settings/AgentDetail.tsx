import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleAlert,
  Download,
  FileDown,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import type {
  AgentManagementView,
  AgentPreflightItemView,
  AgentPreflightView,
  AgentUpdateCheckView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import type { AgentOperationState } from '@/features/agent-management';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from './AgentManagementIcon';

type AgentDetailProps = {
  agent: AgentManagementView;
  operation: AgentOperationState | null;
  preflight: AgentPreflightView | null;
  checking: boolean;
  checkingUpdate: boolean;
  updateCheck: AgentUpdateCheckView | null;
  onSetEnabled: (enabled: boolean) => void;
  onMove: (direction: -1 | 1) => void;
  onPreflight: () => void;
  onInstall: () => void;
  onRepair: () => void;
  onCheckUpdate: () => void;
  onApplyUpdate: () => void;
  onRollback: () => void;
  onCancelOperation: () => void;
  onUninstall: () => void;
  onRemove: () => void;
  onExportDiagnostics: () => void;
};

const operationStages: Record<
  AgentOperationState['kind'],
  readonly [string, string, string, string]
> = {
  install: ['准备', '安装', '验证', '完成'],
  update: ['准备', '更新', '验证', '完成'],
  repair: ['准备', '修复', '验证', '完成'],
  rollback: ['准备', '回滚', '验证', '完成'],
  uninstall: ['准备', '卸载', '清理', '完成'],
  remove: ['准备', '移除', '清理', '完成'],
  check: ['准备', '检查', '汇总', '完成'],
};

function stageIndexForProgress(progress: number) {
  if (progress >= 100) return 3;
  if (progress >= 75) return 2;
  if (progress >= 20) return 1;
  return 0;
}

export function AgentDetail({
  agent,
  operation,
  preflight,
  checking,
  checkingUpdate,
  updateCheck,
  onSetEnabled,
  onMove,
  onPreflight,
  onInstall,
  onRepair,
  onCheckUpdate,
  onApplyUpdate,
  onRollback,
  onCancelOperation,
  onUninstall,
  onRemove,
  onExportDiagnostics,
}: AgentDetailProps) {
  const busy = operation != null || agent.active_operation != null;
  const items = preflight?.items ?? fallbackPreflight(agent);
  const hasRepairableFailure = items.some(
    (item) => item.status === 'fail' && item.repairable
  );
  const canRecoverInstallation =
    !agent.retired && agent.lifecycle !== 'platform_unsupported';
  const needsInstall =
    canRecoverInstallation && agent.lifecycle === 'uninstalled';
  const needsRepair =
    canRecoverInstallation &&
    (agent.lifecycle === 'needs_repair' ||
      (hasRepairableFailure && !needsInstall));
  const progress = Math.min(100, Math.max(0, operation?.progressPercent ?? 0));
  const stages = operation ? operationStages[operation.kind] : null;
  const currentStageIndex = stageIndexForProgress(progress);

  return (
    <div className="space-y-4">
      <header className="agent-detail-header">
        <div className="flex min-w-0 items-center gap-3">
          <div className="agent-detail-icon">
            <AgentManagementIcon agent={agent} className="h-8 w-8" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">
                {agent.display_name}
              </h2>
              <span
                className={cn(
                  'agent-auth-status',
                  authenticationTone(agent.authentication)
                )}
              >
                {authenticationLabel(agent.authentication)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {agent.description}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            aria-label="向前移动"
            disabled={busy}
            onClick={() => onMove(-1)}
          >
            <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            aria-label="向后移动"
            disabled={busy}
            onClick={() => onMove(1)}
          >
            <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
          <label className="agent-detail-enable">
            <span>启用</span>
            <Switch
              aria-label="启用 Agent"
              checked={agent.enabled}
              disabled={busy || agent.retired}
              onCheckedChange={onSetEnabled}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy || agent.retired || checkingUpdate}
            onClick={onCheckUpdate}
          >
            {checkingUpdate ? '正在检查…' : '检查更新'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy || agent.lifecycle === 'uninstalled'}
            onClick={onUninstall}
          >
            卸载
          </Button>
          {!agent.built_in ? (
            <Button
              size="sm"
              variant="destructive"
              className="h-8"
              disabled={busy}
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              移除
            </Button>
          ) : null}
        </div>
      </header>

      {updateCheck ? (
        <section
          aria-label="更新比较"
          className="settings-surface flex flex-wrap items-center justify-between gap-3 px-4 py-3"
        >
          <div>
            <p className="text-sm font-medium text-foreground">
              {updateCheck.update_available
                ? `可更新：${updateCheck.current_version ?? '未知'} → ${updateCheck.available_version}`
                : '当前已是最新版本'}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {updateCheck.fresh
                ? '比较基于当前有效的 Registry 快照。'
                : '比较基于离线缓存；刷新 Registry 后才能安装更新。'}
            </p>
          </div>
          {updateCheck.update_available ? (
            <Button
              size="sm"
              className="h-8"
              disabled={busy || !updateCheck.fresh}
              onClick={onApplyUpdate}
            >
              安装更新
            </Button>
          ) : null}
        </section>
      ) : null}

      <section
        aria-labelledby="agent-preflight-heading"
        className="settings-surface agent-preflight-surface"
      >
        <div className="agent-section-heading">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            <h3 id="agent-preflight-heading">预检查</h3>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={onExportDiagnostics}
            >
              <FileDown aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              导出诊断记录
            </Button>
            {needsInstall ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={busy || agent.retired}
                onClick={onInstall}
              >
                <Download aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                安装 Runtime 与 ACP
              </Button>
            ) : needsRepair ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={busy || agent.retired}
                onClick={onRepair}
              >
                <Wrench aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                修复安装
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={checking || busy}
              onClick={onPreflight}
            >
              {checking ? (
                <Loader2
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              )}
              立即检查
            </Button>
          </div>
        </div>

        {operation ? (
          <div
            aria-live="polite"
            aria-atomic="false"
            className="agent-operation-progress"
          >
            <div className="agent-operation-progress-heading">
              <div className="agent-operation-progress-copy">
                <Loader2
                  aria-hidden="true"
                  className="agent-operation-progress-spinner"
                />
                <div className="min-w-0">
                  <strong>
                    {progress >= 100
                      ? '操作已完成'
                      : `${stages?.[currentStageIndex]}进行中`}
                  </strong>
                  <span>{operation.message ?? '正在处理 Agent 安装'}</span>
                </div>
              </div>
              <span className="agent-operation-progress-value">
                {progress}%
              </span>
            </div>
            <Progress
              aria-label={operation.message ?? '正在处理 Agent 安装'}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-valuetext={`${stages?.[currentStageIndex]} · ${progress}%`}
              className="agent-operation-track"
              value={progress}
            />
            <div className="agent-operation-progress-footer">
              <ol aria-label="操作阶段" className="agent-operation-stages">
                {stages?.map((stage, index) => {
                  const state =
                    index < currentStageIndex
                      ? 'complete'
                      : index === currentStageIndex
                        ? 'current'
                        : 'upcoming';
                  return (
                    <li data-state={state} key={stage}>
                      <span aria-hidden="true" />
                      {stage}
                    </li>
                  );
                })}
              </ol>
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={onCancelOperation}
              >
                取消操作
              </Button>
            </div>
          </div>
        ) : null}

        <ul className="agent-preflight-grid">
          {items.map((item) => (
            <PreflightCard key={item.id} item={item} />
          ))}
        </ul>

        {agent.rollback_available ? (
          <div className="agent-install-actions">
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={busy}
              onClick={onRollback}
            >
              回滚上一版本
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function PreflightCard({ item }: { item: AgentPreflightItemView }) {
  const passed = item.status === 'pass';
  const Icon = passed ? CheckCircle2 : CircleAlert;
  return (
    <li aria-label={`${item.label} 检查结果`}>
      <div className="agent-preflight-card-heading">
        <Icon
          aria-hidden="true"
          className={cn(
            'h-4 w-4 shrink-0',
            passed ? 'text-success' : 'text-warning'
          )}
        />
        <strong>{item.label}</strong>
        <span className={passed ? 'is-pass' : 'is-fail'}>
          {passed ? '可用' : '需处理'}
        </span>
      </div>
      {item.version || item.path ? (
        <PreflightEvidence version={item.version} path={item.path} />
      ) : item.detail ? (
        <p>{item.detail}</p>
      ) : null}
    </li>
  );
}

function PreflightEvidence({
  version,
  path,
}: {
  version: string | null;
  path: string | null;
}) {
  return (
    <dl className="agent-preflight-evidence">
      {version ? (
        <div className="agent-preflight-evidence-row">
          <dt>版本</dt>
          <dd>
            <code className="agent-preflight-evidence-value" title={version}>
              {version}
            </code>
          </dd>
        </div>
      ) : null}
      {path ? (
        <div className="agent-preflight-evidence-row">
          <dt>位置</dt>
          <dd>
            <code className="agent-preflight-evidence-value" title={path}>
              {path}
            </code>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function fallbackPreflight(
  agent: AgentManagementView
): AgentPreflightItemView[] {
  return [
    {
      id: 'membership',
      label: '运行入口',
      status: agent.retired ? 'fail' : 'pass',
      detail: agent.retired
        ? '此 Agent 仅保留历史记录。'
        : 'Agent 已加入本地列表。',
      version: null,
      path: null,
      repairable: false,
    },
    {
      id: 'runtime',
      label: '本地 Runtime',
      status: agent.runtime_version ? 'pass' : 'fail',
      detail: agent.runtime_version
        ? `版本 ${agent.runtime_version}`
        : '未发现本地 Runtime。',
      version: agent.runtime_version,
      path: null,
      repairable: true,
    },
    {
      id: 'acp',
      label: 'ACP 适配器',
      status: agent.acp_version ? 'pass' : 'fail',
      detail: agent.acp_version
        ? `版本 ${agent.acp_version}`
        : '尚未完成 ACP 探测。',
      version: agent.acp_version,
      path: null,
      repairable: true,
    },
  ];
}

function authenticationLabel(
  authentication: AgentManagementView['authentication']
): string {
  switch (authentication) {
    case 'account':
      return '已通过账号登录';
    case 'api_key':
      return '已通过 API Key 登录';
    case 'not_logged_in':
      return '暂未登录';
    case 'multiple_unknown':
      return '登录来源待确认';
    case 'not_required':
      return '无需登录';
  }
}

function authenticationTone(
  authentication: AgentManagementView['authentication']
): string {
  if (authentication === 'account' || authentication === 'api_key') {
    return 'is-success';
  }
  if (authentication === 'not_logged_in') return 'is-warning';
  return 'is-neutral';
}
