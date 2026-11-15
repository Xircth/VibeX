import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  PlugZap,
  Star,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DEFAULT_PROVIDER_AGENTS,
  formatAgentDisplayLabel,
  groupProviderInstancesByAgent,
  isValidOnePasswordReference,
  providerInstancesApi,
  type ProviderAuthMode,
  type ProviderAuthModeKind,
  type ProviderConnectionTestResult,
  type ProviderInstanceConfig,
  type ProviderInstancesApi,
  type UpsertProviderInstanceInput,
} from '@/lib/providerInstancesApi';
import { cn } from '@/lib/utils';

export interface ProviderInstanceManagerProps {
  api?: ProviderInstancesApi;
  initialInstances?: ProviderInstanceConfig[];
  seedAgents?: ReadonlyArray<{ agentId: string; label: string }>;
  onInstancesChange?: (instances: ProviderInstanceConfig[]) => void;
}

interface InstanceFormState {
  mode: 'create' | 'edit';
  editingInstanceId?: string;
  agentId: string;
  displayName: string;
  authModeKind: ProviderAuthModeKind;
  accountEmail: string;
  apiKeySecret: string;
  opReference: string;
  isDefault: boolean;
}

function makeCreateForm(agentId: string): InstanceFormState {
  return {
    mode: 'create',
    agentId,
    displayName: '',
    authModeKind: 'OfficialOAuth',
    accountEmail: '',
    apiKeySecret: '',
    opReference: '',
    isDefault: false,
  };
}

function makeEditForm(instance: ProviderInstanceConfig): InstanceFormState {
  return {
    mode: 'edit',
    editingInstanceId: instance.instanceId,
    agentId: instance.agentId,
    displayName: instance.displayName,
    authModeKind: instance.authMode.mode,
    accountEmail:
      instance.authMode.mode === 'OfficialOAuth'
        ? (instance.authMode.accountEmail ?? '')
        : '',
    apiKeySecret: '',
    opReference:
      instance.authMode.mode === 'SecretManager'
        ? instance.authMode.opReference
        : '',
    isDefault: instance.isDefault,
  };
}

function buildAuthModePayload(form: InstanceFormState): ProviderAuthMode {
  if (form.authModeKind === 'SecretManager') {
    return {
      mode: 'SecretManager',
      opReference: form.opReference.trim(),
    };
  }
  if (form.authModeKind === 'ApiKey') {
    return {
      mode: 'ApiKey',
    };
  }
  return {
    mode: 'OfficialOAuth',
    accountEmail: form.accountEmail.trim() || null,
  };
}

export function ProviderInstanceManager({
  api = providerInstancesApi,
  initialInstances,
  seedAgents = DEFAULT_PROVIDER_AGENTS,
  onInstancesChange,
}: ProviderInstanceManagerProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [instances, setInstances] = useState<ProviderInstanceConfig[]>(
    () => initialInstances ?? []
  );
  const [isLoading, setIsLoading] = useState(!initialInstances);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form, setForm] = useState<InstanceFormState | null>(null);
  const [formValidationError, setFormValidationError] = useState<string | null>(
    null
  );
  const [isSaving, setIsSaving] = useState(false);

  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, ProviderConnectionTestResult>
  >({});

  const refreshInstances = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const next = await api.list();
      setInstances(next);
      onInstancesChange?.(next);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [api, onInstancesChange]);

  useEffect(() => {
    if (initialInstances) return;
    void refreshInstances();
  }, [initialInstances, refreshInstances]);

  const groups = useMemo(
    () => groupProviderInstancesByAgent(instances, seedAgents),
    [instances, seedAgents]
  );

  const agentOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const seed of seedAgents) {
      map.set(seed.agentId, seed.label);
    }
    for (const grp of groups) {
      if (!map.has(grp.agentId)) {
        map.set(grp.agentId, grp.label);
      }
    }
    return Array.from(map.entries()).map(([agentId, label]) => ({
      agentId,
      label,
    }));
  }, [groups, seedAgents]);

  const renderAuthSummary = (instance: ProviderInstanceConfig): string => {
    if (instance.authMode.mode === 'OfficialOAuth') {
      return instance.authMode.accountEmail
        ? t('settings:providerInstances.summaryOAuth', {
            account: instance.authMode.accountEmail,
          })
        : t('settings:providerInstances.summaryOAuthConfigured');
    }
    if (instance.authMode.mode === 'ApiKey') {
      return t('settings:providerInstances.summaryApiKey', {
        preview: instance.authMode.maskedPreview || '••••••••',
      });
    }
    return t('settings:providerInstances.summarySecretManager', {
      reference: instance.authMode.opReference,
    });
  };

  const buildUpsertInput = (state: InstanceFormState): UpsertProviderInstanceInput => ({
    instanceId: state.editingInstanceId,
    agentId: state.agentId,
    displayName: state.displayName.trim(),
    authMode: buildAuthModePayload(state),
    apiKeySecret:
      state.authModeKind === 'ApiKey' && state.apiKeySecret.trim()
        ? state.apiKeySecret.trim()
        : undefined,
    isDefault: state.isDefault,
  });

  const validateForm = (state: InstanceFormState): string | null => {
    if (!state.displayName.trim()) {
      return t('settings:providerInstances.displayNameLabel');
    }
    if (
      state.authModeKind === 'SecretManager' &&
      !isValidOnePasswordReference(state.opReference)
    ) {
      return t('settings:providerInstances.opReferenceInvalid');
    }
    return null;
  };

  const handleSaveForm = async () => {
    if (!form) return;
    const validationErr = validateForm(form);
    if (validationErr) {
      setFormValidationError(validationErr);
      return;
    }
    setFormValidationError(null);
    setIsSaving(true);
    try {
      const payload = buildUpsertInput(form);
      if (form.mode === 'edit' && form.editingInstanceId) {
        await api.update(form.editingInstanceId, payload);
      } else {
        await api.create(payload);
      }
      setForm(null);
      await refreshInstances();
    } catch (error) {
      setFormValidationError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestExisting = async (instance: ProviderInstanceConfig) => {
    const key = `card:${instance.instanceId}`;
    setTestingKey(key);
    try {
      const result = await api.testConnection({
        agentId: instance.agentId,
        instanceId: instance.instanceId,
      });
      setTestResults((prev) => ({ ...prev, [key]: result }));
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [key]: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setTestingKey(null);
    }
  };

  const handleTestForm = async () => {
    if (!form) return;
    const validationErr = validateForm(form);
    if (validationErr) {
      setFormValidationError(validationErr);
      return;
    }
    setFormValidationError(null);
    const key = 'form';
    setTestingKey(key);
    try {
      const result = await api.testConnection(buildUpsertInput(form));
      setTestResults((prev) => ({ ...prev, [key]: result }));
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [key]: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setTestingKey(null);
    }
  };

  const handleSetDefault = async (instance: ProviderInstanceConfig) => {
    setErrorMessage(null);
    try {
      await api.setDefault(instance.agentId, instance.instanceId);
      await refreshInstances();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async (instance: ProviderInstanceConfig) => {
    if (instance.isDefault || instance.hasActiveSessions) return;
    setErrorMessage(null);
    try {
      await api.remove(instance.agentId, instance.instanceId);
      await refreshInstances();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section
      data-testid="provider-instance-manager"
      className="space-y-5"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {t('settings:providerInstances.title')}
        </h3>
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {errorMessage ? (
        <div
          role="alert"
          data-testid="provider-instances-error"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <div className="space-y-5">
        {groups.map((group) => (
          <div
            key={group.agentId}
            data-testid={`provider-group-${group.agentId}`}
            className="rounded-xl border border-border bg-card/50 p-4"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AgentTypeIcon
                  agentType={group.agentId}
                  className="h-4 w-4 text-foreground"
                />
                <span className="text-sm font-semibold text-foreground">
                  {group.label}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setFormValidationError(null);
                  setTestResults((prev) => {
                    const next = { ...prev };
                    delete next.form;
                    return next;
                  });
                  setForm(makeCreateForm(group.agentId));
                }}
                data-testid={`add-instance-${group.agentId}`}
                className="h-7 gap-1 px-2.5 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>
                  {t('settings:providerInstances.addInstance', {
                    agent: formatAgentDisplayLabel(group.agentId),
                  })}
                </span>
              </Button>
            </div>

            {group.instances.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">
                {t('settings:providerInstances.emptyGroup')}
              </div>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border bg-background/60">
                {group.instances.map((instance) => {
                  const cardKey = `card:${instance.instanceId}`;
                  const testResult = testResults[cardKey];
                  const deleteDisabledReason = instance.hasActiveSessions
                    ? t('settings:providerInstances.deleteDisabledActive')
                    : instance.isDefault
                      ? t('settings:providerInstances.deleteDisabledDefault')
                      : undefined;
                  const isDeleteDisabled = Boolean(deleteDisabledReason);

                  return (
                    <div
                      key={instance.instanceId}
                      data-testid={`provider-instance-card-${instance.instanceId}`}
                      className="space-y-2 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--success))]"
                              aria-hidden="true"
                            />
                            <span className="text-xs font-semibold text-foreground">
                              {instance.displayName}
                            </span>
                            {instance.isDefault ? (
                              <span
                                data-testid={`default-badge-${instance.instanceId}`}
                                className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary"
                              >
                                {t('settings:providerInstances.defaultBadge')}
                              </span>
                            ) : null}
                            {instance.hasActiveSessions ? (
                              <span
                                data-testid={`active-badge-${instance.instanceId}`}
                                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                              >
                                {t(
                                  'settings:providerInstances.activeSessionsBadge'
                                )}
                              </span>
                            ) : null}
                          </div>

                          <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                            <KeyRound className="h-3 w-3 shrink-0 opacity-70" />
                            <span className="truncate">
                              {renderAuthSummary(instance)}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={testingKey === cardKey}
                            onClick={() => void handleTestExisting(instance)}
                            data-testid={`test-instance-${instance.instanceId}`}
                            className="h-7 gap-1 px-2 text-xs"
                          >
                            {testingKey === cardKey ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <PlugZap className="h-3 w-3" />
                            )}
                            <span>
                              {testingKey === cardKey
                                ? t('settings:providerInstances.testing')
                                : t('settings:providerInstances.testConnection')}
                            </span>
                          </Button>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setFormValidationError(null);
                              setForm(makeEditForm(instance));
                            }}
                            data-testid={`edit-instance-${instance.instanceId}`}
                            className="h-7 gap-1 px-2 text-xs"
                          >
                            <Pencil className="h-3 w-3" />
                            <span>{t('settings:providerInstances.edit')}</span>
                          </Button>

                          {!instance.isDefault ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void handleSetDefault(instance)}
                              data-testid={`set-default-${instance.instanceId}`}
                              className="h-7 gap-1 px-2 text-xs"
                            >
                              <Star className="h-3 w-3" />
                              <span>
                                {t('settings:providerInstances.setDefault')}
                              </span>
                            </Button>
                          ) : null}

                          <span
                            title={deleteDisabledReason}
                            data-testid={`delete-wrapper-${instance.instanceId}`}
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={isDeleteDisabled}
                              aria-label={
                                deleteDisabledReason
                                  ? `${t('settings:providerInstances.delete')} — ${deleteDisabledReason}`
                                  : t('settings:providerInstances.delete')
                              }
                              onClick={() => void handleDelete(instance)}
                              data-testid={`delete-instance-${instance.instanceId}`}
                              className={cn(
                                'h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive',
                                isDeleteDisabled && 'pointer-events-none'
                              )}
                            >
                              <Trash2 className="h-3 w-3" />
                              <span>
                                {t('settings:providerInstances.delete')}
                              </span>
                            </Button>
                          </span>
                        </div>
                      </div>

                      {testResult ? (
                        <div
                          data-testid={`test-result-${instance.instanceId}`}
                          className={cn(
                            'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs',
                            testResult.ok
                              ? 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]'
                              : 'bg-destructive/10 text-destructive'
                          )}
                        >
                          {testResult.ok ? (
                            <>
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                              <span>
                                {t('settings:providerInstances.testSuccess')}
                              </span>
                            </>
                          ) : (
                            <>
                              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                              <span>
                                {t('settings:providerInstances.testFailed', {
                                  error: testResult.error ?? 'Unknown error',
                                })}
                              </span>
                            </>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {form ? (
        <div
          data-testid="provider-instance-form"
          className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm"
        >
          <div className="text-sm font-semibold text-foreground">
            {form.mode === 'edit'
              ? t('settings:providerInstances.editTitle')
              : t('settings:providerInstances.createTitle')}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="font-medium text-foreground">
                {t('settings:providerInstances.agentLabel')}
              </span>
              <select
                value={form.agentId}
                disabled={form.mode === 'edit'}
                onChange={(e) =>
                  setForm((prev) =>
                    prev ? { ...prev, agentId: e.target.value } : prev
                  )
                }
                data-testid="form-agent-select"
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground disabled:opacity-60"
              >
                {agentOptions.map((opt) => (
                  <option key={opt.agentId} value={opt.agentId}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium text-foreground">
                {t('settings:providerInstances.displayNameLabel')}
              </span>
              <input
                type="text"
                value={form.displayName}
                onChange={(e) =>
                  setForm((prev) =>
                    prev ? { ...prev, displayName: e.target.value } : prev
                  )
                }
                placeholder={t(
                  'settings:providerInstances.displayNamePlaceholder'
                )}
                data-testid="form-display-name-input"
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="font-medium text-foreground">
                {t('settings:providerInstances.authModeLabel')}
              </span>
              <select
                value={form.authModeKind}
                onChange={(e) =>
                  setForm((prev) =>
                    prev
                      ? {
                          ...prev,
                          authModeKind: e.target.value as ProviderAuthModeKind,
                        }
                      : prev
                  )
                }
                data-testid="form-auth-mode-select"
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground"
              >
                <option value="OfficialOAuth">
                  {t('settings:providerInstances.authModeOAuth')}
                </option>
                <option value="ApiKey">
                  {t('settings:providerInstances.authModeApiKey')}
                </option>
                <option value="SecretManager">
                  {t('settings:providerInstances.authModeSecretManager')}
                </option>
              </select>
            </label>

            {form.authModeKind === 'OfficialOAuth' ? (
              <label className="space-y-1 text-xs">
                <span className="font-medium text-foreground">
                  {t('settings:providerInstances.accountEmailLabel')}
                </span>
                <input
                  type="email"
                  value={form.accountEmail}
                  onChange={(e) =>
                    setForm((prev) =>
                      prev ? { ...prev, accountEmail: e.target.value } : prev
                    )
                  }
                  placeholder={t(
                    'settings:providerInstances.accountEmailPlaceholder'
                  )}
                  data-testid="form-oauth-email-input"
                  className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
            ) : form.authModeKind === 'ApiKey' ? (
              <label className="space-y-1 text-xs">
                <span className="font-medium text-foreground">
                  {t('settings:providerInstances.apiKeyLabel')}
                </span>
                <input
                  type="password"
                  value={form.apiKeySecret}
                  onChange={(e) =>
                    setForm((prev) =>
                      prev ? { ...prev, apiKeySecret: e.target.value } : prev
                    )
                  }
                  placeholder={t(
                    'settings:providerInstances.apiKeyPlaceholder'
                  )}
                  data-testid="form-api-key-input"
                  className="h-8 w-full rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
            ) : (
              <label className="space-y-1 text-xs">
                <span className="font-medium text-foreground">
                  {t('settings:providerInstances.opReferenceLabel')}
                </span>
                <input
                  type="text"
                  value={form.opReference}
                  onChange={(e) =>
                    setForm((prev) =>
                      prev ? { ...prev, opReference: e.target.value } : prev
                    )
                  }
                  placeholder={t(
                    'settings:providerInstances.opReferencePlaceholder'
                  )}
                  data-testid="form-op-reference-input"
                  className="h-8 w-full rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
            )}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            <Switch
              checked={form.isDefault}
              onCheckedChange={(checked) =>
                setForm((prev) =>
                  prev ? { ...prev, isDefault: checked } : prev
                )
              }
              data-testid="form-is-default-switch"
            />
            <span>{t('settings:providerInstances.setAsDefaultLabel')}</span>
          </label>

          {formValidationError ? (
            <div
              role="alert"
              data-testid="form-validation-error"
              className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
            >
              {formValidationError}
            </div>
          ) : null}

          {testResults.form ? (
            <div
              data-testid="form-test-result"
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs',
                testResults.form.ok
                  ? 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]'
                  : 'bg-destructive/10 text-destructive'
              )}
            >
              {testResults.form.ok ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('settings:providerInstances.testSuccess')}</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {t('settings:providerInstances.testFailed', {
                      error: testResults.form.error ?? 'Unknown error',
                    })}
                  </span>
                </>
              )}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testingKey === 'form' || isSaving}
              onClick={() => void handleTestForm()}
              data-testid="form-test-connection-btn"
              className="h-8 gap-1.5 text-xs"
            >
              {testingKey === 'form' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlugZap className="h-3.5 w-3.5" />
              )}
              <span>
                {testingKey === 'form'
                  ? t('settings:providerInstances.testing')
                  : t('settings:providerInstances.testConnection')}
              </span>
            </Button>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isSaving}
                onClick={() => setForm(null)}
                data-testid="form-cancel-btn"
                className="h-8 text-xs"
              >
                {t('common:cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={isSaving}
                onClick={() => void handleSaveForm()}
                data-testid="form-save-btn"
                className="h-8 text-xs"
              >
                {t('common:save')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
