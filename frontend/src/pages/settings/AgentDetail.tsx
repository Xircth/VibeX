import {
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Stethoscope,
  Trash2,
  Wrench,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { type ReactNode, useEffect, useRef, useState } from 'react';
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
import {
  PRODUCT_MENU_CONTENT_CLASS,
  PRODUCT_MENU_ITEM_CLASS,
} from '@/components/ui/product-menu-classes';
import { Switch } from '@/components/ui/switch';
import type { AgentOperationState } from '@/features/agent-management';
import { readCachedAgentAcpUpdate } from '@/features/agent-management/agentAcpUpdates';
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
  onExportDiagnostics?: () => void;
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
    enrichPreflightItemsWithKnownUpdate(
      preflight?.items ?? fallbackPreflight(t, agent, updateCheck),
      agent,
      updateCheck
    )
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
  const [installPopoverStep, setInstallPopoverStep] = useState<
    'menu' | 'custom_version' | null
  >(null);
  const installPopoverRef = useRef<HTMLDivElement>(null);
  const [specifiedCompatibilityWarning, setSpecifiedCompatibilityWarning] =
    useState<string | null>(null);
  useEffect(() => {
    setCustomVersion('');
    setInstallPopoverStep(null);
    setSpecifiedCompatibilityWarning(null);
    setDisableDialogOpen(false);
  }, [agent.agent_id]);
  useEffect(() => {
    if (!needsInstall || busy || agent.retired) {
      setInstallPopoverStep(null);
    }
  }, [agent.retired, busy, needsInstall]);
  useEffect(() => {
    if (installPopoverStep === null) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        installPopoverRef.current &&
        !installPopoverRef.current.contains(event.target as Node)
      ) {
        setInstallPopoverStep(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setInstallPopoverStep(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [installPopoverStep]);
  useEffect(() => {
    if (!focusDiagnostics) return;
    setDiagnosticsOpen(true);
    setOperationDiagnosticsEnabled(true);
  }, [focusDiagnostics]);
  const customVersionValid = isValidCustomVersion(customVersion);
  useEffect(() => {
    if (
      installPopoverStep !== 'custom_version' ||
      !customVersionValid ||
      !onPreviewVersions
    ) {
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
    installPopoverStep,
    onPreviewVersions,
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
                key="env-diagnostics"
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
            {needsInstall ? (
              <div
                key="install-acp"
                ref={installPopoverRef}
                className="relative"
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  aria-expanded={installPopoverStep !== null}
                  aria-haspopup="menu"
                  disabled={busy || agent.retired}
                  onClick={() =>
                    setInstallPopoverStep((current) =>
                      current === null ? 'menu' : null
                    )
                  }
                >
                  <Download aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                  {t('agents.installRuntimeAcp')}
                </Button>
                {installPopoverStep === 'menu' ? (
                  <div
                    key="install-menu"
                    data-floating-layer="popover"
                    className={cn(
                      PRODUCT_MENU_CONTENT_CLASS,
                      'tahoe-popover absolute right-0 top-full z-50 mt-1.5 min-w-[8.5rem] p-1 shadow-md'
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        PRODUCT_MENU_ITEM_CLASS,
                        'w-full whitespace-nowrap px-2.5 py-1.5'
                      )}
                      onClick={() => {
                        setInstallPopoverStep(null);
                        onInstall();
                      }}
                    >
                      {t('agents.installLatestVersion')}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        PRODUCT_MENU_ITEM_CLASS,
                        'w-full whitespace-nowrap px-2.5 py-1.5'
                      )}
                      onClick={() => setInstallPopoverStep('custom_version')}
                    >
                      {t('agents.specifyVersion')}
                    </button>
                  </div>
                ) : installPopoverStep === 'custom_version' ? (
                  <form
                    key="install-custom-version"
                    data-floating-layer="popover"
                    className="tahoe-popover absolute right-0 top-full z-50 mt-1.5 w-72 rounded-md border border-border bg-popover p-2.5 text-popover-foreground shadow-md"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (busy || agent.retired || !customVersionValid) return;
                      setInstallPopoverStep(null);
                      onInstallVersion?.({
                        acpVersion: customVersion.trim(),
                      });
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        aria-label={t('agents.customVersionLabel')}
                        aria-invalid={Boolean(
                          customVersion && !customVersionValid
                        )}
                        autoComplete="off"
                        autoFocus
                        className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary"
                        disabled={busy || agent.retired}
                        placeholder={
                          updateCheck?.acp_available ??
                          updateCheck?.available_version ??
                          agent.acp_version ??
                          t('agents.customVersionPlaceholder')
                        }
                        spellCheck={false}
                        value={customVersion}
                        onChange={(event) =>
                          setCustomVersion(event.target.value)
                        }
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="h-8 shrink-0"
                        disabled={busy || agent.retired || !customVersionValid}
                      >
                        {t('common:confirm')}
                      </Button>
                    </div>
                    {customVersionValid ? null : customVersion ? (
                      <p role="alert" className="mt-1.5 text-xs text-destructive">
                        {t('agents.customVersionInvalid')}
                      </p>
                    ) : null}
                    {specifiedCompatibilityWarning ? (
                      <p
                        role="status"
                        className="mt-1.5 text-xs text-amber-700 dark:text-amber-400"
                      >
                        {specifiedCompatibilityWarning}
                      </p>
                    ) : null}
                  </form>
                ) : null}
              </div>
            ) : needsRepair ? (
              <Button
                key="repair-acp"
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
                key="external-install-guide"
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
              key="check-now"
              size="sm"
              variant="outline"
              className="h-8"
              disabled={checking || busy}
              onClick={onPreflight}
            >
              {checking ? (
                <Loader2
                  key="loading"
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <RefreshCw
                  key="refresh"
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5"
                />
              )}
              {t('agents.checkNow')}
            </Button>
          </div>
        </AgentSectionHeading>

        {preflightExpanded ? (
          <>
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
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">
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

function enrichPreflightItemsWithKnownUpdate(
  items: AgentPreflightItemView[],
  agent: AgentManagementView,
  updateCheck: AgentUpdateCheckView | null
): AgentPreflightItemView[] {
  const cachedUpdate = readCachedAgentAcpUpdate(
    agent.agent_id,
    agent.acp_version
  );
  const hasKnownUpdate =
    updateCheck != null
      ? updateCheck.update_available
      : Boolean(cachedUpdate?.available);
  if (!hasKnownUpdate) return items;
  const knownAvailableVersion =
    updateCheck?.acp_available ??
    updateCheck?.available_version ??
    cachedUpdate?.availableVersion ??
    null;
  return items.map((item) => {
    if (item.id !== 'acp' || item.status === 'fail' || item.update_available) {
      return item;
    }
    return {
      ...item,
      update_available: true,
      available_version: item.available_version ?? knownAvailableVersion,
    };
  });
}

function fallbackPreflight(
  t: TFunction<'settings'>,
  agent: AgentManagementView,
  updateCheck?: AgentUpdateCheckView | null
): AgentPreflightItemView[] {
  const cachedUpdate = readCachedAgentAcpUpdate(
    agent.agent_id,
    agent.acp_version
  );
  const updateAvailable =
    updateCheck != null
      ? updateCheck.update_available
      : Boolean(cachedUpdate?.available);
  const availableVersion = updateAvailable
    ? (updateCheck?.acp_available ??
      updateCheck?.available_version ??
      cachedUpdate?.availableVersion ??
      null)
    : null;
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
      update_available: Boolean(agent.acp_version && updateAvailable),
      available_version: agent.acp_version ? availableVersion : null,
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
