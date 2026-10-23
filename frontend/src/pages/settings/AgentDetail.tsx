import {
  Download,
  ExternalLink,
  FileDown,
  Loader2,
  RefreshCw,
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import type { AgentOperationState } from '@/features/agent-management';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { cn } from '@/lib/utils';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import { AgentOperationProgress } from './AgentOperationProgress';
import {
  AgentPreflightCard,
  humanizePreflightId,
} from './AgentPreflightCheckItem';
import { agentProvisioningAction } from './agentProvisioning';
import { presentPreflightItems } from './agentPreflightSnapshot';
import { AgentSectionHeading } from './SettingsSection';

const OPERATION_DIAGNOSTICS_KEY = 'vibex:operation-diagnostics';

type AgentDetailProps = {
  agent: AgentManagementView;
  operation: AgentOperationState | null;
  preflight: AgentPreflightView | null;
  authentication?: ReactNode;
  diagnostics?: AgentDiagnosticView[];
  checking: boolean;
  checkingUpdate?: boolean;
  updateCheck: AgentUpdateCheckView | null;
  onSetEnabled: (enabled: boolean) => void;
  onPreflight: () => void;
  onInstall: () => void;
  onInstallVersion?: (input: {
    version?: string;
    runtimeVersion?: string;
    acpVersion?: string;
  }) => void;
  onPreviewVersions?: (input: {
    runtimeVersion?: string;
    acpVersion?: string;
  }) => Promise<string | null>;
  onRepair: () => void;
  onCheckUpdate?: () => void;
  onRollback: () => void;
  onCancelOperation: () => void;
  onUninstall: (options?: { clearData?: boolean }) => void;
  onRemove: () => void;
  onExportDiagnostics: () => void;
  onMarkAllDiagnosticsRead?: () => void;
  onEnvironmentDiagnostics?: () => void;
  onUpdatePreflightItem?: (itemId: string) => void;
  focusDiagnostics?: boolean;
};

export function AgentDetail({
  agent,
  operation,
  preflight,
  authentication,
  diagnostics = [],
  checking,
  updateCheck,
  onSetEnabled,
  onPreflight,
  onInstall,
  onInstallVersion,
  onPreviewVersions,
  onRepair,
  onRollback,
  onCancelOperation,
  onUninstall,
  onRemove,
  onExportDiagnostics,
  onMarkAllDiagnosticsRead,
  onEnvironmentDiagnostics,
  onUpdatePreflightItem,
  focusDiagnostics = false,
}: AgentDetailProps) {
  const { t, i18n } = useTranslation('settings');
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const [operationDiagnosticsEnabled, setOperationDiagnosticsEnabled] =
    useState(
      () =>
        focusDiagnostics ||
        localStorage.getItem(OPERATION_DIAGNOSTICS_KEY) !== 'off'
    );
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(focusDiagnostics);
  const toggleOperationDiagnostics = (enabled: boolean) => {
    setOperationDiagnosticsEnabled(enabled);
    localStorage.setItem(OPERATION_DIAGNOSTICS_KEY, enabled ? 'on' : 'off');
    void persistFrontendPreference('vibex:operation-diagnostics', enabled);
  };
  const unreadDiagnostics = diagnostics.filter(
    (diagnostic) => !diagnostic.read
  ).length;
  const [preflightExpanded, setPreflightExpanded] = useState(true);
  const busy = operation != null || agent.active_operation != null;
  const items = presentPreflightItems(
    preflight?.items ?? fallbackPreflight(t, agent)
  );
  const provisioningAction = agentProvisioningAction(agent, items);
  const needsInstall = provisioningAction === 'install';
  const needsRepair = provisioningAction === 'repair';
  const acpPreflightItem = items.find((item) => item.id === 'acp');
  const externalInstallUrl =
    agent.agent_id === 'kiro' && acpPreflightItem?.status === 'fail'
      ? 'https://kiro.dev/docs/getting-started/installation/'
      : null;
  const [customVersion, setCustomVersion] = useState('');
  const [specifiedCompatibilityWarning, setSpecifiedCompatibilityWarning] =
    useState<string | null>(null);
  useEffect(() => {
    setCustomVersion('');
    setSpecifiedCompatibilityWarning(null);
    setDisableDialogOpen(false);
  }, [agent.agent_id]);
  useEffect(() => {
    if (!focusDiagnostics) return;
    setDiagnosticsOpen(true);
    setOperationDiagnosticsEnabled(true);
  }, [focusDiagnostics]);
  const customVersionValid = isValidCustomVersion(customVersion);
  const supportsCustomVersion =
    agent.built_in &&
    agent.agent_id !== 'hermes' &&
    agent.agent_id !== 'kiro' &&
    onInstallVersion != null;
  useEffect(() => {
    if (!supportsCustomVersion || !customVersionValid || !onPreviewVersions) {
      setSpecifiedCompatibilityWarning(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onPreviewVersions({
        acpVersion: customVersion.trim() || undefined,
      }).then((warning) => {
        if (!cancelled) {
          setSpecifiedCompatibilityWarning(warning);
        }
      });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    customVersion,
    customVersionValid,
    onPreviewVersions,
    supportsCustomVersion,
  ]);

  return (
    <div className="space-y-4">
      <header className="agent-detail-header">
        <div className="agent-detail-header-identity">
          <div className="agent-detail-icon">
            <AgentManagementIcon agent={agent} className="h-8 w-8" />
          </div>
          <div className="agent-detail-header-copy">
            <div className="agent-detail-header-title">
              <h2 className="text-base font-semibold text-foreground">
                {agent.display_name}
              </h2>
              <span
                className={cn(
                  'agent-auth-status shrink-0',
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
        <div className="agent-detail-header-actions">
          <label
            className="agent-detail-enable"
            data-basic-guide="settings-agent-enable"
          >
            <span>{t('agents.enable')}</span>
            <Switch
              aria-label={t('agents.enableAgent')}
              checked={agent.enabled}
              disabled={busy || agent.retired}
              onCheckedChange={(nextEnabled) => {
                if (nextEnabled) {
                  onSetEnabled(true);
                } else {
                  setDisableDialogOpen(true);
                }
              }}
            />
          </label>
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

      <Dialog
        aria-labelledby="agent-disable-dialog-title"
        className="max-w-md"
        open={disableDialogOpen}
        onOpenChange={setDisableDialogOpen}
      >
        <DialogHeader>
          <DialogTitle id="agent-disable-dialog-title">
            {t('agents.disableDialogTitle', { agent: agent.display_name })}
          </DialogTitle>
          <DialogDescription>
            {t('agents.disableDialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDisableDialogOpen(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-dialog-primary="true"
            onClick={() => {
              setDisableDialogOpen(false);
              onSetEnabled(false);
            }}
          >
            {t('agents.disableOnly')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDisableDialogOpen(false);
              onUninstall({ clearData: false });
            }}
          >
            {t('agents.disableAndUninstall')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setDisableDialogOpen(false);
              onUninstall({ clearData: true });
            }}
          >
            {t('agents.disableAndClearData')}
          </Button>
        </DialogFooter>
      </Dialog>

      <div data-basic-guide="settings-agent-auth">{authentication}</div>

      <section
        aria-labelledby="agent-preflight-heading"
        className="settings-surface agent-preflight-surface"
      >
        <AgentSectionHeading
          headingId="agent-preflight-heading"
          title={t('agents.preflightTitle')}
          expanded={preflightExpanded}
          onToggle={() => setPreflightExpanded((current) => !current)}
          summary={preflightSummary(
            t,
            i18n.language,
            items,
            preflight?.checked_at
          )}
        >
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
            {externalInstallUrl ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() =>
                  window.open(
                    externalInstallUrl,
                    '_blank',
                    'noopener,noreferrer'
                  )
                }
              >
                <ExternalLink
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5"
                />
                {t('agents.officialInstallGuide', '官方安装指南')}
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
        </AgentSectionHeading>

        {preflightExpanded ? (
          <>
            {supportsCustomVersion ? (
              <details className="agent-custom-version">
                <summary>{t('agents.customVersionInstall')}</summary>
                <div className="agent-custom-version-body">
                  <label>
                    <span>{t('agents.customVersionLabel')}</span>
                    <input
                      aria-label={t('agents.customVersionLabel')}
                      aria-invalid={Boolean(
                        customVersion && !customVersionValid
                      )}
                      autoComplete="off"
                      disabled={busy || agent.retired}
                      placeholder={
                        updateCheck?.acp_available ??
                        updateCheck?.available_version ??
                        agent.acp_version ??
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
                    onClick={() =>
                      onInstallVersion?.({
                        acpVersion: customVersion.trim(),
                      })
                    }
                  >
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                    {t('agents.installSpecifiedVersion')}
                  </Button>
                </div>
                {customVersionValid ? null : customVersion ? (
                  <p role="alert">{t('agents.customVersionInvalid')}</p>
                ) : null}
                {specifiedCompatibilityWarning ? (
                  <p role="status" className="text-xs text-amber-700">
                    {specifiedCompatibilityWarning}
                  </p>
                ) : null}
                <small>{t('agents.customVersionTrustHint')}</small>
              </details>
            ) : null}

            {operation ? (
              <AgentOperationProgress
                operation={operation}
                onCancel={onCancelOperation}
              />
            ) : null}

            <ul className="agent-preflight-grid">
              {items.map((item) => (
                <AgentPreflightCard
                  key={item.id}
                  item={item}
                  busy={busy}
                  onUpdate={
                    onUpdatePreflightItem
                      ? () => onUpdatePreflightItem(item.id)
                      : undefined
                  }
                />
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
          </>
        ) : null}
      </section>

      {diagnostics.length > 0 ? (
        <details
          className="settings-surface"
          open={diagnosticsOpen}
          onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
        >
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
  return [
    {
      id: 'membership',
      label: t('agents.runtimeEntry'),
      status: agent.retired ? 'fail' : 'pass',
      detail: agent.retired
        ? t('agents.retiredHistoryOnly')
        : agent.acp_version
          ? t('agents.runtimeEntryAvailable')
          : t('agents.runtimeVersionUnconfirmed'),
      version: agent.acp_version,
      path: null,
      source: null,
      repairable: false,
      update_available: false,
      available_version: null,
      update_group: null,
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
      update_available: false,
      available_version: null,
      update_group: null,
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
