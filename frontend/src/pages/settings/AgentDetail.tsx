import {
  Download,
  FileDown,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Wrench,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDiagnosticView,
  AgentManagementView,
  AgentPreflightItemView,
  AgentPreflightView,
  AgentUpdateCheckView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import type { AgentOperationState } from '@/features/agent-management';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import { AgentPreflightCheckItem } from './AgentPreflightCheckItem';

const OPERATION_DIAGNOSTICS_KEY = 'vibex:operation-diagnostics';

type AgentDetailProps = {
  agent: AgentManagementView;
  operation: AgentOperationState | null;
  preflight: AgentPreflightView | null;
  authentication?: ReactNode;
  diagnostics?: AgentDiagnosticView[];
  checking: boolean;
  checkingUpdate: boolean;
  updateCheck: AgentUpdateCheckView | null;
  onSetEnabled: (enabled: boolean) => void;
  onPreflight: () => void;
  onInstall: () => void;
  onInstallVersion?: (version: string) => void;
  onRepair: () => void;
  onCheckUpdate: () => void;
  onApplyUpdate: () => void;
  onRollback: () => void;
  onCancelOperation: () => void;
  onUninstall: () => void;
  onRemove: () => void;
  onExportDiagnostics: () => void;
  onMarkAllDiagnosticsRead?: () => void;
  onEnvironmentDiagnostics?: () => void;
};

const operationStages: Record<
  AgentOperationState['kind'],
  readonly [string, string, string, string]
> = {
  install: ['stagePrepare', 'stageInstall', 'stageVerify', 'stageComplete'],
  update: ['stagePrepare', 'stageUpdate', 'stageVerify', 'stageComplete'],
  repair: ['stagePrepare', 'stageRepair', 'stageVerify', 'stageComplete'],
  rollback: ['stagePrepare', 'stageRollback', 'stageVerify', 'stageComplete'],
  uninstall: [
    'stagePrepare',
    'stageUninstall',
    'stageCleanup',
    'stageComplete',
  ],
  remove: ['stagePrepare', 'stageRemove', 'stageCleanup', 'stageComplete'],
  check: ['stagePrepare', 'stageCheck', 'stageSummary', 'stageComplete'],
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
  authentication,
  diagnostics = [],
  checking,
  checkingUpdate,
  updateCheck,
  onSetEnabled,
  onPreflight,
  onInstall,
  onInstallVersion,
  onRepair,
  onCheckUpdate,
  onApplyUpdate,
  onRollback,
  onCancelOperation,
  onUninstall,
  onRemove,
  onExportDiagnostics,
  onMarkAllDiagnosticsRead,
  onEnvironmentDiagnostics,
}: AgentDetailProps) {
  const { t, i18n } = useTranslation('settings');
  const [operationDiagnosticsEnabled, setOperationDiagnosticsEnabled] =
    useState(() => localStorage.getItem(OPERATION_DIAGNOSTICS_KEY) !== 'off');
  const toggleOperationDiagnostics = (enabled: boolean) => {
    setOperationDiagnosticsEnabled(enabled);
    localStorage.setItem(OPERATION_DIAGNOSTICS_KEY, enabled ? 'on' : 'off');
    void persistFrontendPreference('vibex:operation-diagnostics', enabled);
  };
  const unreadDiagnostics = diagnostics.filter(
    (diagnostic) => !diagnostic.read
  ).length;
  const busy = operation != null || agent.active_operation != null;
  const items = preflight?.items ?? fallbackPreflight(t, agent);
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
  const stages = operation
    ? operationStages[operation.kind].map((stage) => t(`agents.${stage}`))
    : null;
  const currentStageIndex = stageIndexForProgress(progress);
  const localizedOperationMessage = operation
    ? operationMessage(t, i18n.resolvedLanguage, operation)
    : null;
  const [customVersion, setCustomVersion] = useState('');
  useEffect(() => setCustomVersion(''), [agent.agent_id]);
  const customVersionValid = isValidCustomVersion(customVersion);
  const supportsCustomVersion =
    agent.built_in && agent.agent_id !== 'hermes' && onInstallVersion != null;

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
                {authenticationLabel(t, agent.authentication)}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {agent.description}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <label className="agent-detail-enable">
            <span>{t('agents.enable')}</span>
            <Switch
              aria-label={t('agents.enableAgent')}
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
            {checkingUpdate ? t('agents.checking') : t('agents.checkUpdates')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy || agent.lifecycle === 'uninstalled'}
            onClick={onUninstall}
          >
            {t('agents.fixUninstall')}
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
              {t('agents.remove')}
            </Button>
          ) : null}
        </div>
      </header>

      {updateCheck ? (
        <section
          aria-label={t('agents.updateComparison')}
          className="settings-surface flex flex-wrap items-center justify-between gap-3 px-4 py-3"
        >
          <div>
            <p className="text-sm font-medium text-foreground">
              {updateCheck.update_available
                ? t('agents.updateVersions', {
                    current:
                      updateCheck.current_version ?? t('agents.versionUnknown'),
                    available: updateCheck.available_version,
                  })
                : t('agents.upToDate')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {updateCheck.fresh
                ? t('agents.updateFreshSnapshot')
                : t('agents.updateOfflineSnapshot')}
            </p>
          </div>
          {updateCheck.update_available ? (
            <Button
              size="sm"
              className="h-8"
              disabled={busy || !updateCheck.fresh}
              onClick={onApplyUpdate}
            >
              {t('agents.installUpdate')}
            </Button>
          ) : null}
        </section>
      ) : null}

      {authentication}

      <section
        aria-labelledby="agent-preflight-heading"
        className="settings-surface agent-preflight-surface"
      >
        <div className="agent-section-heading">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            <div>
              <h3 id="agent-preflight-heading">{t('agents.preflightTitle')}</h3>
              <p className="agent-section-caption" aria-live="polite">
                {preflightSummary(
                  t,
                  i18n.language,
                  items,
                  preflight?.checked_at
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {onEnvironmentDiagnostics ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={busy}
                onClick={onEnvironmentDiagnostics}
              >
                <Stethoscope
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5"
                />
                {t('agents.environmentDiagnosticsAction')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={onExportDiagnostics}
            >
              <FileDown aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              {t('agents.exportDiagnostics')}
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
                {t('agents.installRuntimeAcp')}
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
                {t('agents.repairInstallation')}
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
              {t('agents.checkNow')}
            </Button>
          </div>
        </div>

        {supportsCustomVersion ? (
          <details className="agent-custom-version">
            <summary>{t('agents.customVersionInstall')}</summary>
            <div className="agent-custom-version-body">
              <label>
                <span>{t('agents.customVersionLabel')}</span>
                <input
                  aria-label={t('agents.customVersionLabel')}
                  aria-invalid={Boolean(customVersion && !customVersionValid)}
                  autoComplete="off"
                  disabled={busy || agent.retired}
                  placeholder={
                    agent.runtime_version ??
                    t('agents.customVersionPlaceholder')
                  }
                  spellCheck={false}
                  value={customVersion}
                  onChange={(event) => setCustomVersion(event.target.value)}
                />
              </label>
              <Button
                className="h-8 shrink-0"
                disabled={busy || agent.retired || !customVersionValid}
                size="sm"
                variant="outline"
                onClick={() => onInstallVersion?.(customVersion.trim())}
              >
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
                {t('agents.installSpecifiedVersion')}
              </Button>
            </div>
            {customVersion && !customVersionValid ? (
              <p role="alert">{t('agents.customVersionInvalid')}</p>
            ) : null}
            <small>{t('agents.customVersionTrustHint')}</small>
          </details>
        ) : null}

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
                      ? t('agents.operationComplete')
                      : t('agents.stageInProgress', {
                          stage: stages?.[currentStageIndex],
                        })}
                  </strong>
                  <span>{localizedOperationMessage}</span>
                </div>
              </div>
              <span className="agent-operation-progress-value">
                {progress}%
              </span>
            </div>
            <Progress
              aria-label={
                localizedOperationMessage ?? t('agents.processingInstallation')
              }
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-valuetext={`${stages?.[currentStageIndex]} · ${progress}%`}
              className="agent-operation-track"
              value={progress}
            />
            {operation.logs && operation.logs.length > 1 ? (
              <div
                aria-label={t('agents.installLog')}
                className="agent-operation-log"
                role="log"
              >
                {operation.logs.map((line, index) => (
                  <div key={`${index}:${line}`}>
                    {localizedOperationLogLine(t, i18n.resolvedLanguage, line)}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="agent-operation-progress-footer">
              <ol
                aria-label={t('agents.operationStages')}
                className="agent-operation-stages"
              >
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
                {t('agents.cancelOperation')}
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
              {t('agents.rollbackPrevious')}
            </Button>
          </div>
        ) : null}
      </section>

      {diagnostics.length > 0 ? (
        <details className="settings-surface">
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
            <span className="flex items-center gap-2">
              {t('agents.diagnosticsTitle')} · {diagnostics.length}
              {unreadDiagnostics > 0 ? (
                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                  {t('agents.diagnosticsUnread', {
                    count: unreadDiagnostics,
                  })}
                </span>
              ) : null}
            </span>
            <span
              className="flex items-center gap-3"
              onClick={(event) => event.stopPropagation()}
            >
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                {t('agents.operationDiagnosticsEnabled')}
                <Switch
                  checked={operationDiagnosticsEnabled}
                  onCheckedChange={toggleOperationDiagnostics}
                  aria-label={t('agents.operationDiagnosticsEnabled')}
                />
              </label>
              {operationDiagnosticsEnabled && onMarkAllDiagnosticsRead ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={unreadDiagnostics === 0}
                  onClick={onMarkAllDiagnosticsRead}
                >
                  {t('agents.markAllDiagnosticsRead')}
                </Button>
              ) : null}
            </span>
          </summary>
          {operationDiagnosticsEnabled ? (
            <ul className="space-y-2 px-4 py-3">
              {diagnostics.slice(0, 20).map((diagnostic) => (
                <li
                  className={cn(
                    'rounded-md border px-3 py-2',
                    !diagnostic.read && 'border-primary/40 bg-primary/5'
                  )}
                  key={diagnostic.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <strong>
                      {humanizePreflightId(diagnostic.operation_kind)} ·{' '}
                      {diagnosticSeverity(t, diagnostic.severity)}
                    </strong>
                    <time className="text-muted-foreground">
                      {formatDiagnosticTime(
                        i18n.language,
                        diagnostic.created_at
                      )}
                    </time>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {localizedDiagnosticMessage(
                      t,
                      i18n.resolvedLanguage,
                      diagnostic
                    )}
                  </p>
                  {diagnostic.redacted_output ? (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">
                      {diagnostic.redacted_output}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

export function isValidCustomVersion(value: string): boolean {
  const normalized = value.trim().replace(/^[vV]/, '');
  return (
    normalized.length <= 128 &&
    normalized.includes('.') &&
    /^[0-9][0-9A-Za-z.+-]*$/u.test(normalized)
  );
}

function PreflightCard({ item }: { item: AgentPreflightItemView }) {
  const { t, i18n } = useTranslation('settings');
  const passed = item.status === 'pass';
  const warning = item.status === 'warning';
  const english = i18n.resolvedLanguage?.startsWith('en') ?? false;
  const label = english ? humanizePreflightId(item.id) : item.label;
  const detail =
    english && item.detail && /[\u3400-\u9fff]/u.test(item.detail)
      ? passed
        ? t('agents.preflightDetailPass', { label })
        : warning
          ? t('agents.preflightDetailWarning', { label })
          : item.repairable
            ? t('agents.preflightDetailRepairable', { label })
            : t('agents.preflightDetailFail', { label })
      : item.detail;
  return <AgentPreflightCheckItem detail={detail} item={item} label={label} />;
}

function humanizePreflightId(value: string): string {
  const known: Record<string, string> = {
    runtime: 'Runtime',
    acp: 'ACP adapter',
    node: 'Node.js',
    npm: 'npm',
    uv: 'uv',
    python: 'Python',
    archive: 'Archive support',
    authentication: 'Authentication',
  };
  const leaf = value.split('.').at(-1) ?? value;
  if (known[leaf]) return known[leaf];
  return leaf
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

function preflightSummary(
  t: TFunction<'settings'>,
  language: string,
  items: AgentPreflightItemView[],
  checkedAt: string | null | undefined
): string {
  const failed = items.filter((item) => item.status === 'fail').length;
  const warnings = items.filter((item) => item.status === 'warning').length;
  const passed = items.length - failed - warnings;
  const parts = [
    t('agents.preflightAvailableCount', { passed, total: items.length }),
  ];
  if (failed) parts.push(t('agents.preflightFailedCount', { count: failed }));
  if (warnings) {
    parts.push(t('agents.preflightWarningCount', { count: warnings }));
  }
  if (checkedAt) {
    const date = new Date(checkedAt);
    if (!Number.isNaN(date.getTime())) {
      parts.push(
        t('agents.preflightCheckedAt', {
          time: new Intl.DateTimeFormat(language, {
            hour: '2-digit',
            minute: '2-digit',
          }).format(date),
        })
      );
    }
  }
  return parts.join(' · ');
}

function operationMessage(
  t: TFunction<'settings'>,
  language: string | undefined,
  operation: AgentOperationState
): string {
  if (!language?.startsWith('en') && operation.message?.trim()) {
    return operation.message;
  }
  if (operation.status === 'succeeded') return t('agents.operationComplete');
  if (operation.status === 'failed') return t('agents.operationFailed');
  if (operation.status === 'canceled') return t('agents.operationCanceled');
  if (operation.status === 'interrupted') {
    return t('agents.operationInterrupted');
  }
  if (operation.status === 'queued') return t('agents.operationQueued');
  return t(`agents.operationProgress.${operation.kind}`);
}

function localizedOperationLogLine(
  t: TFunction<'settings'>,
  language: string | undefined,
  line: string
): string {
  if (!language?.startsWith('en')) return line;
  const key = {
    正在解析已锁定的安装方案: 'resolvePlan',
    '正在安装本地 Runtime 与 ACP': 'installRuntime',
    '正在验证 ACP 握手': 'verifyAcp',
    正在发布本地终端命令: 'publishCommand',
    '安装与 ACP 验证完成': 'complete',
    操作已取消: 'canceled',
    正在取消操作: 'canceling',
  }[line] as
    | 'resolvePlan'
    | 'installRuntime'
    | 'verifyAcp'
    | 'publishCommand'
    | 'complete'
    | 'canceled'
    | 'canceling'
    | undefined;
  return key ? t(`agents.operationLog.${key}`) : line;
}

function localizedDiagnosticMessage(
  t: TFunction<'settings'>,
  language: string | undefined,
  diagnostic: AgentDiagnosticView
): string {
  if (
    language?.startsWith('en') &&
    /[\u3400-\u9fff]/u.test(diagnostic.message)
  ) {
    return t('agents.diagnosticFallback', {
      operation: humanizePreflightId(diagnostic.operation_kind),
    });
  }
  return diagnostic.message;
}

function diagnosticSeverity(
  t: TFunction<'settings'>,
  severity: string
): string {
  if (severity === 'error') return t('agents.diagnosticError');
  if (severity === 'warning') return t('agents.diagnosticWarning');
  return t('agents.diagnosticInfo');
}

function formatDiagnosticTime(language: string, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

function fallbackPreflight(
  t: TFunction<'settings'>,
  agent: AgentManagementView
): AgentPreflightItemView[] {
  const runtimeAvailable = Boolean(
    agent.runtime_version || agent.local_runtime
  );
  return [
    {
      id: 'membership',
      label: t('agents.runtimeEntry'),
      status: agent.retired ? 'fail' : 'pass',
      detail: agent.retired
        ? t('agents.retiredHistoryOnly')
        : t('agents.agentAdded'),
      version: null,
      path: null,
      source: null,
      repairable: false,
    },
    {
      id: 'runtime',
      label: t('agents.localRuntime'),
      status: runtimeAvailable ? 'pass' : 'fail',
      detail: runtimeAvailable ? '' : t('agents.localRuntimeMissing'),
      version: agent.runtime_version ?? agent.local_runtime?.version ?? null,
      path: agent.local_runtime?.path ?? null,
      source: null,
      repairable: true,
    },
    {
      id: 'acp',
      label: t('agents.runtimeAcp'),
      status: agent.acp_version ? 'pass' : 'fail',
      detail: agent.acp_version ? '' : t('agents.acpProbePending'),
      version: agent.acp_version,
      path: null,
      source: null,
      repairable: true,
    },
  ];
}

function authenticationLabel(
  t: TFunction<'settings'>,
  authentication: AgentManagementView['authentication']
): string {
  switch (authentication) {
    case 'account':
      return t('agents.authAccount');
    case 'api_key':
      return t('agents.authApiKey');
    case 'not_logged_in':
      return t('agents.authNotLoggedIn');
    case 'multiple_unknown':
      return t('agents.authUnknown');
    case 'not_required':
      return t('agents.authNotRequired');
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
