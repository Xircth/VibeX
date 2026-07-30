import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleAlert,
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
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { AgentOperationState } from '@/features/agent-management';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from './AgentManagementIcon';

type AgentDetailProps = {
  agent: AgentManagementView;
  operation: AgentOperationState | null;
  preflight: AgentPreflightView | null;
  checking: boolean;
  onSetEnabled: (enabled: boolean) => void;
  onMove: (direction: -1 | 1) => void;
  onPreflight: () => void;
  onRepair: () => void;
  onUpdate: () => void;
  onRollback: () => void;
  onCancelOperation: () => void;
  onUninstall: () => void;
  onRemove: () => void;
  onExportDiagnostics: () => void;
};

export function AgentDetail({
  agent,
  operation,
  preflight,
  checking,
  onSetEnabled,
  onMove,
  onPreflight,
  onRepair,
  onUpdate,
  onRollback,
  onCancelOperation,
  onUninstall,
  onRemove,
  onExportDiagnostics,
}: AgentDetailProps) {
  const busy = operation != null || agent.active_operation != null;
  const items = preflight?.items ?? fallbackPreflight(agent);

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
            disabled={busy || agent.retired}
            onClick={onUpdate}
          >
            检查更新
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
        </div>
      </header>

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
            {agent.lifecycle === 'needs_repair' ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={busy}
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
          <div aria-label="安装进度" className="agent-operation-progress">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Loader2
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 animate-spin text-primary"
                />
                <span className="truncate text-sm font-medium text-foreground">
                  {operation.message ?? '正在处理本地安装'}
                </span>
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">
                {operation.progressPercent ?? 0}%
              </span>
            </div>
            <div className="agent-operation-track">
              <span style={{ width: `${operation.progressPercent ?? 0}%` }} />
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                className="h-8"
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

        {agent.rollback_available || !agent.built_in ? (
          <div className="agent-install-actions">
            {agent.rollback_available ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={busy}
                onClick={onRollback}
              >
                回滚上一版本
              </Button>
            ) : null}
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
        ) : null}
      </section>
    </div>
  );
}

function PreflightCard({ item }: { item: AgentPreflightItemView }) {
  const passed = item.status === 'pass';
  const Icon = passed ? CheckCircle2 : CircleAlert;
  return (
    <li>
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
      <p>{item.detail}</p>
    </li>
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
      repairable: false,
    },
    {
      id: 'runtime',
      label: '本地 Runtime',
      status: agent.runtime_version ? 'pass' : 'fail',
      detail: agent.runtime_version
        ? `版本 ${agent.runtime_version}`
        : '未发现本地 Runtime。',
      repairable: true,
    },
    {
      id: 'acp',
      label: 'ACP 适配器',
      status: agent.acp_version ? 'pass' : 'fail',
      detail: agent.acp_version
        ? `版本 ${agent.acp_version}`
        : '尚未完成 ACP 探测。',
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
