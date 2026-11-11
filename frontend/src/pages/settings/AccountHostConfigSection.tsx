import { useCallback, useContext, useMemo, useState } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import {
  ArrowDownToLine,
  Bot,
  Laptop,
  Loader2,
  Server,
  Settings,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import {
  useAccountHostConfigs,
  useAccountSavedHosts,
  useVibeXAccount,
  type AccountHostConfigSnapshot,
  type AccountHostKind,
} from '@/features/model-router';
import { openSettingsSurface } from '@/lib/api';
import { cn } from '@/lib/utils';

const REMOTE_CLIENT_SETTINGS_PATH = '/settings/web-service?role=client';

function useSafeNavigate(): (path: string) => void {
  const navContext = useContext(UNSAFE_NavigationContext);
  return useCallback(
    (path: string) => {
      if (navContext?.navigator) {
        navContext.navigator.push(path);
      } else if (typeof window !== 'undefined') {
        window.location.assign(path);
      }
    },
    [navContext]
  );
}

function HostKindIcon({
  kind,
  className,
}: {
  kind: AccountHostKind;
  className?: string;
}) {
  if (kind === 'local') {
    return <Laptop className={className} aria-hidden="true" />;
  }
  if (kind === 'ssh') {
    return <Terminal className={className} aria-hidden="true" />;
  }
  return <Server className={className} aria-hidden="true" />;
}

function formatPlatformBadge(osType: string, osArch: string): string | null {
  const normalizedOs = osType.trim();
  const normalizedArch = osArch.trim();
  if (!normalizedOs && !normalizedArch) return null;
  const osLabel = /^macos|darwin$/i.test(normalizedOs)
    ? 'macOS'
    : /^windows$/i.test(normalizedOs)
      ? 'Windows'
      : /^linux$/i.test(normalizedOs)
        ? 'Linux'
        : normalizedOs;
  if (osLabel && normalizedArch) {
    return `${osLabel} · ${normalizedArch}`;
  }
  return osLabel || normalizedArch;
}

export function AccountHostConfigSection() {
  const { t } = useTranslation(['settings', 'common']);
  const navigate = useSafeNavigate();
  const { isSignedIn } = useVibeXAccount();
  const { currentHost, hostEntries, isImporting, importFromHost } =
    useAccountHostConfigs();
  const { savedHosts } = useAccountSavedHosts();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedSource, setSelectedSource] =
    useState<AccountHostConfigSnapshot | null>(null);
  const [includeSettings, setIncludeSettings] = useState(true);
  const [includeAgents, setIncludeAgents] = useState(true);

  const openImportDialogFor = (host: AccountHostConfigSnapshot) => {
    setSelectedSource(host);
    setIncludeSettings(true);
    setIncludeAgents(true);
    setDialogOpen(true);
  };

  const handleConfirmImport = async () => {
    if (!selectedSource || (!includeSettings && !includeAgents)) return;
    try {
      const result = await importFromHost(selectedSource, {
        includeSettings,
        includeAgents,
      });
      setDialogOpen(false);
      if (result.skippedMissingAgentIds.length > 0) {
        toast.success(
          t('settings:account.hostConfigImportPartialAgents', {
            name: selectedSource.hostName,
            skipped: result.skippedMissingAgentIds.length,
          })
        );
      } else {
        toast.success(
          t('settings:account.hostConfigImportSuccess', {
            name: selectedSource.hostName,
          })
        );
      }
    } catch {
      toast.error(t('settings:account.hostConfigImportFailed'));
    }
  };

  const renderAgentsSummary = (host: AccountHostConfigSnapshot) => {
    const total = host.agents.length;
    const enabledCount = host.agents.filter((item) => item.enabled).length;
    if (total === 0 || enabledCount === 0) {
      return t('settings:account.hostConfigAgentsNone');
    }
    return t('settings:account.hostConfigAgentsSummary', {
      enabled: enabledCount,
      total,
    });
  };

  const selectedEnabledAgentNames = useMemo(() => {
    if (!selectedSource) return '';
    return selectedSource.agents
      .filter((item) => item.enabled)
      .map((item) => item.displayName)
      .join('、');
  }, [selectedSource]);

  if (!isSignedIn) {
    return null;
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2.5" data-testid="account-host-list-section">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('settings:account.hostsSectionTitle')}
        </h3>

        <div className="settings-card overflow-hidden rounded-xl border border-border bg-card divide-y divide-border/60">
          {hostEntries.map((entry) => {
            const platformBadge = formatPlatformBadge(
              entry.osType,
              entry.osArch
            );
            return (
              <div
                key={entry.hostId}
                data-testid={
                  entry.isCurrent
                    ? 'account-current-host-row'
                    : `account-saved-host-row-${entry.hostId}`
                }
                className="flex items-center justify-between gap-4 px-5 py-3.5"
              >
                <div className="flex min-w-0 items-center gap-3.5">
                  <div
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                      entry.isCurrent
                        ? 'border-primary/25 bg-primary/10 text-primary'
                        : 'border-border bg-muted/40 text-muted-foreground'
                    )}
                  >
                    <HostKindIcon kind={entry.kind} className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {entry.hostName}
                      </span>
                      {entry.isCurrent ? (
                        <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                          {t('settings:account.hostConfigCurrentBadge')}
                        </span>
                      ) : null}
                      {platformBadge ? (
                        <span className="inline-flex items-center rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {platformBadge}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                {entry.isCurrent ? null : entry.snapshot ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`account-import-host-${entry.hostId}`}
                    className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
                    onClick={() => openImportDialogFor(entry.snapshot!)}
                  >
                    <ArrowDownToLine
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                    <span>{t('settings:account.hostConfigImportAction')}</span>
                  </Button>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('settings:account.hostConfigUnsyncedLabel')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {savedHosts.length > 0 ? (
        <section
          className="space-y-2.5"
          data-testid="account-saved-remote-hosts-section"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t('settings:account.savedRemoteHostsTitle')}
            </h3>
            <button
              type="button"
              data-testid="account-manage-remote-hosts"
              onClick={() =>
                openSettingsSurface(navigate, REMOTE_CLIENT_SETTINGS_PATH)
              }
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Settings className="h-3 w-3" aria-hidden="true" />
              <span>{t('settings:account.savedRemoteHostsManage')}</span>
            </button>
          </div>

          <div className="settings-card overflow-hidden rounded-xl border border-border bg-card divide-y divide-border/60">
            {savedHosts.map((item) => (
              <div
                key={item.id}
                data-testid={`account-remote-target-row-${item.id}`}
                className="flex items-center justify-between gap-4 px-5 py-3.5"
              >
                <div className="flex min-w-0 items-center gap-3.5">
                  <div
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                      item.connected
                        ? 'border-primary/25 bg-primary/10 text-primary'
                        : 'border-border bg-muted/40 text-muted-foreground'
                    )}
                  >
                    {item.kind === 'ssh' ? (
                      <Terminal className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Server className="h-4 w-4" aria-hidden="true" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {item.name}
                      </span>
                      <span className="inline-flex items-center rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {item.kind === 'ssh'
                          ? t('settings:account.savedRemoteHostSshBadge')
                          : t('settings:account.savedRemoteHostHttpBadge')}
                      </span>
                      {item.connected ? (
                        <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                          {t('settings:account.savedRemoteHostConnectedBadge')}
                        </span>
                      ) : item.needsToken ? (
                        <span className="inline-flex items-center rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                          {t('settings:account.savedRemoteHostNeedsTokenBadge')}
                        </span>
                      ) : item.hasCredential ? (
                        <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                          {t('settings:account.savedRemoteHostPairedBadge')}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground tabular-nums">
                      {item.targetLabel}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="max-w-md"
          data-testid="account-host-import-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {t('settings:account.hostConfigImportDialogTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('settings:account.hostConfigImportDialogDesc', {
                target: currentHost?.hostName ?? 'Local Host',
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {selectedSource ? (
              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/30 px-3.5 py-2.5">
                <HostKindIcon
                  kind={selectedSource.kind}
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-foreground">
                    {selectedSource.hostName}
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    {renderAgentsSummary(selectedSource)}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">
                {t('settings:account.hostConfigScopeLabel')}
              </div>

              <label
                data-testid="import-scope-settings"
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                  includeSettings
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border bg-card hover:bg-accent/40'
                )}
              >
                <input
                  type="checkbox"
                  checked={includeSettings}
                  onChange={(event) => setIncludeSettings(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <SlidersHorizontal
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>
                      {t('settings:account.hostConfigScopeSettingsTitle')}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t('settings:account.hostConfigScopeSettingsDesc')}
                  </p>
                </div>
              </label>

              <label
                data-testid="import-scope-agents"
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                  includeAgents
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border bg-card hover:bg-accent/40'
                )}
              >
                <input
                  type="checkbox"
                  checked={includeAgents}
                  onChange={(event) => setIncludeAgents(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <Bot
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>
                      {t('settings:account.hostConfigScopeAgentsTitle')}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t('settings:account.hostConfigScopeAgentsDesc')}
                  </p>
                  {selectedEnabledAgentNames ? (
                    <p className="mt-1 truncate text-[11px] text-foreground/80">
                      {t('settings:account.hostConfigScopeAgentsPreview', {
                        names: selectedEnabledAgentNames,
                      })}
                    </p>
                  ) : null}
                </div>
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isImporting}
              onClick={() => setDialogOpen(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="confirm-host-config-import"
              disabled={
                isImporting ||
                !selectedSource ||
                (!includeSettings && !includeAgents)
              }
              onClick={() => void handleConfirmImport()}
            >
              {isImporting ? (
                <>
                  <Loader2
                    className="mr-1.5 h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  <span>{t('settings:account.hostConfigImporting')}</span>
                </>
              ) : (
                <span>{t('settings:account.hostConfigImportConfirm')}</span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
