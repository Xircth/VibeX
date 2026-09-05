import {
  CreditCard,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Settings2,
} from 'lucide-react';
import {
  type ReactNode,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentAuthModeKind,
  AgentAuthModeOptionView,
  AgentAuthModeView,
  AgentAuthenticationStatus,
  AgentId,
  AgentManagementActionKind,
  AgentManagementActionView,
  AgentManagementActionsView,
} from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';
import { cn } from '@/lib/utils';

import {
  clearAgentSettingsDraft,
  peekAgentSettingsDraft,
  retainAgentSettingsDraft,
} from './agentSettingsDraftRetention';
import { AgentAccountIdentity } from './AgentAccountIdentity';
import { CodexDeviceLogin } from './CodexDeviceLogin';

type AuthDraft = {
  mode: string;
  apiKey: string;
};

function authDraftKey(agentId: AgentId) {
  return `auth-mode:${agentId}`;
}

type Props = {
  agentId: AgentId;
  actions?: AgentManagementActionsView | null;
  actionRunning?: string | null;
  authentication?: AgentAuthenticationStatus;
  busy?: boolean;
  configuration?: ReactNode | ((mode: string) => ReactNode);
  headingExtra?: ReactNode;
  modelProvider?: ReactNode;
  accountExtra?: ReactNode;
  nativeCredentialPresent?: (fieldId: string) => boolean;
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onAuthenticated?: () => void;
  onRunAction?: (actionId: string) => void;
  locked?: boolean;
};

export function AgentAuthModeControl({
  agentId,
  actions = null,
  actionRunning = null,
  authentication,
  busy = false,
  configuration,
  headingExtra,
  modelProvider,
  accountExtra,
  nativeCredentialPresent,
  onChanged,
  onDirtyChange,
  onAuthenticated,
  onRunAction,
  locked = false,
}: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [view, setView] = useState<AgentAuthModeView | null>(null);
  const retained = peekAgentSettingsDraft<AuthDraft>(authDraftKey(agentId));
  const [mode, setMode] = useState(retained?.mode ?? 'subscription');
  const [apiKey, setApiKey] = useState(retained?.apiKey ?? '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const autoPersisted = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await agentManagementApi.authMode(agentId);
      setView(next);
      const kept = peekAgentSettingsDraft<AuthDraft>(authDraftKey(agentId));
      setMode(kept?.mode ?? next.mode);
      if (kept) setApiKey(kept.apiKey);
    } catch (error) {
      const message = errorMessage(error, t('settings:agents.authLoadFailed'));
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [agentId, t]);

  useEffect(() => void load(), [authentication, load]);

  const selectedOption = view?.options.find((option) => option.value === mode);
  const selectedKind = selectedOption?.kind ?? kindOfMode(mode);
  const kindOptions =
    view?.options.filter((option) => option.kind === selectedKind) ?? [];
  const kindTabs = AUTH_KIND_ORDER.filter((kind) =>
    view?.options.some((option) => option.kind === kind)
  );
  const requiresCredential = selectedOption?.credential_required ?? false;
  const credentialEnv = selectedOption?.credential_env ?? 'API_KEY';
  const nativeConfigFieldId = selectedOption?.native_config_field_id ?? null;
  const credentialAvailable = credentialIsAvailable(
    view,
    selectedOption,
    apiKey,
    nativeCredentialPresent
  );
  const dirty = Boolean(view && apiKey.length > 0);
  const panel = authenticationPanel(selectedKind, Boolean(modelProvider));
  const displayName = agentDisplayName(agentId);
  const signedIn = accountSessionActive(authentication);
  const showCodexDeviceLogin = agentId === 'codex' && !signedIn;

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!view) return;
    const key = authDraftKey(agentId);
    if (mode !== view.mode || apiKey.length > 0) {
      retainAgentSettingsDraft(key, { mode, apiKey });
    } else {
      clearAgentSettingsDraft(key);
    }
  }, [agentId, apiKey, mode, view]);

  const persistMode = useCallback(
    async (nextMode: string, nextApiKey = '') => {
      if (locked) return false;
      setSaving(true);
      setMode(nextMode);
      try {
        const next = await agentManagementApi.setAuthMode(
          agentId,
          nextMode,
          nextApiKey.trim() || null
        );
        setView(next);
        setMode(next.mode);
        setApiKey('');
        clearAgentSettingsDraft(authDraftKey(agentId));
        return true;
      } catch (error) {
        toast.error(errorMessage(error, t('settings:agents.authSaveFailed')));
        setMode(view?.mode ?? nextMode);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [agentId, locked, t, view?.mode]
  );

  useEffect(() => {
    if (!view || saving || loading) return;
    if (mode === view.mode) {
      autoPersisted.current = null;
      return;
    }
    if (view.mode === 'model_provider') {
      return;
    }
    if (
      !selectedOption?.credential_required ||
      !selectedOption.native_config_field_id ||
      !credentialAvailable
    ) {
      return;
    }
    if (autoPersisted.current === mode) return;
    autoPersisted.current = mode;
    void persistMode(mode).then((ok) => {
      if (!ok) autoPersisted.current = null;
    });
  }, [
    credentialAvailable,
    loading,
    mode,
    persistMode,
    saving,
    selectedOption,
    view,
  ]);

  const selectKind = async (nextKind: AgentAuthModeKind) => {
    if (!view || saving || locked) return;
    const options = view.options.filter((option) => option.kind === nextKind);
    const next = options.find((option) => option.value === mode) ?? options[0];
    if (!next) return;
    await selectMode(next.value);
  };

  const selectMode = async (nextMode: string) => {
    if (!view || nextMode === mode || saving || locked) return;
    const nextOption = view.options.find((option) => option.value === nextMode);
    const nextAvailable = credentialIsAvailable(
      view,
      nextOption,
      apiKey,
      nativeCredentialPresent
    );
    if (nextMode === view.mode) {
      setMode(nextMode);
      setApiKey('');
      return;
    }
    if (view.credential_present && nextOption?.kind === 'subscription') {
      const result = await ConfirmDialog.show({
        title: t('settings:agents.authSwitchAwayFromKeyTitle'),
        message: t('settings:agents.authSwitchAwayFromKeyMessage', {
          mode: t(nextOption?.label_key ?? 'settings:agents.authModeUnknown'),
        }),
        confirmText: t('settings:agents.authSwitchAwayFromKeyConfirm'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });
      if (result !== 'confirmed') return;
    }
    if (persistsImmediately(nextOption, nextAvailable, view.mode)) {
      await persistMode(nextMode);
      return;
    }
    setMode(nextMode);
    if (!nextOption?.credential_required || nextOption.native_config_field_id) {
      setApiKey('');
    }
  };

  const saveCredential = async () => {
    const ok = await persistMode(mode, apiKey);
    if (!ok) return;
    toast.success(t('settings:agents.authSaved'));
    await onChanged?.();
  };

  const moveTabFocus = (current: AgentAuthModeKind, delta: number) => {
    if (!view) return;
    const index = kindTabs.findIndex((kind) => kind === current);
    const next = kindTabs[(index + delta + kindTabs.length) % kindTabs.length];
    document.getElementById(authKindTabId(agentId, next))?.focus();
  };

  return (
    <section
      aria-labelledby={`${agentId}-auth-mode-heading`}
      className="settings-surface agent-auth-mode-surface"
    >
      <div className="agent-section-heading">
        <h3 id={`${agentId}-auth-mode-heading`}>
          {t('settings:agents.authTitle')}
        </h3>
        <div className="agent-auth-mode-heading-tools">
          {panel === 'configuration' ? headingExtra : null}
          {view && kindTabs.length > 1 ? (
            <div
              className="agent-auth-mode-tabs"
              role="tablist"
              aria-label={t('settings:agents.authModeAria', {
                agent: displayName,
              })}
            >
              {kindTabs.map((kind) => {
                const selected = kind === selectedKind;
                const viewKind = view.options.find(
                  (option) => option.value === view.mode
                )?.kind;
                const draft = selected && viewKind !== kind;
                const fullLabel = t(authKindTabLabelKey(kind));
                return (
                  <button
                    key={kind}
                    id={authKindTabId(agentId, kind)}
                    type="button"
                    role="tab"
                    aria-label={fullLabel}
                    aria-selected={selected}
                    aria-controls={`${agentId}-auth-mode-panel`}
                    tabIndex={selected ? 0 : -1}
                    className={cn(selected && 'is-active', draft && 'is-draft')}
                    disabled={saving || locked}
                    onClick={() => void selectKind(kind)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        moveTabFocus(kind, 1);
                      } else if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        moveTabFocus(kind, -1);
                      } else if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void selectKind(kind);
                      }
                    }}
                  >
                    {fullLabel}
                    {draft ? (
                      <span
                        className="agent-auth-mode-tab-draft"
                        aria-label={t('settings:agents.authModeUnsaved')}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      <div className="agent-auth-mode-frame">
        {loading && !view ? (
          <p className="agent-auth-mode-loading" aria-live="polite">
            {t('settings:agents.authLoading')}
          </p>
        ) : loadError && !view ? (
          <div className="agent-inline-error" role="alert">
            <span>{loadError}</span>
            <Button
              className="h-8 shrink-0"
              size="sm"
              variant="outline"
              onClick={() => void load()}
            >
              {t('settings:agents.retryRead')}
            </Button>
          </div>
        ) : view ? (
          <div
            id={`${agentId}-auth-mode-panel`}
            className="agent-auth-mode-body"
            role={kindTabs.length > 1 ? 'tabpanel' : undefined}
          >
            {kindOptions.length > 1 && panel !== 'account' ? (
              <div className="agent-auth-mode-submodes">
                {kindOptions.map((option) => (
                  <SubmodeButton
                    key={option.value}
                    option={option}
                    active={option.value === mode}
                    disabled={saving}
                    onSelect={() => void selectMode(option.value)}
                  />
                ))}
              </div>
            ) : null}

            {panel === 'configuration' && selectedOption?.official_api_url ? (
              <label className="agent-auth-mode-field">
                <span>API URL</span>
                <Input
                  aria-label="API URL"
                  readOnly
                  value={selectedOption.official_api_url}
                />
              </label>
            ) : null}

            {requiresCredential &&
            !nativeConfigFieldId &&
            panel === 'configuration' ? (
              <label className="agent-auth-mode-field agent-auth-mode-credential">
                <span>{credentialEnv}</span>
                <div className="agent-auth-mode-secret-row">
                  <div className="agent-auth-mode-secret">
                    <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
                    <Input
                      aria-label={credentialEnv}
                      autoComplete="new-password"
                      className="agent-auth-mode-secret-input"
                      name={`${agentId}_api_key`}
                      placeholder={
                        view.mode === mode && view.credential_present
                          ? t('settings:agents.credentialSavedPlaceholder')
                          : t('settings:agents.credentialPlaceholder')
                      }
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                  </div>
                  <Button
                    className="h-8 shrink-0"
                    disabled={saving || !credentialAvailable}
                    size="sm"
                    onClick={() => void saveCredential()}
                  >
                    {saving ? (
                      <Loader2
                        aria-hidden="true"
                        className="h-3.5 w-3.5 animate-spin"
                      />
                    ) : null}
                    {saving
                      ? t('settings:agents.saving')
                      : t('settings:agents.authSave')}
                  </Button>
                </div>
              </label>
            ) : null}

            <div className="agent-auth-mode-panel" hidden={panel !== 'account'}>
              {showCodexDeviceLogin && panel === 'account' ? (
                <CodexDeviceLogin onAuthenticated={onAuthenticated} />
              ) : null}
              {accountExtra && panel === 'account' ? accountExtra : null}
              {panel === 'account' ? (
                <AccountSessionBar
                  signedIn={signedIn}
                  accountLabel={view?.account_label}
                  actions={sessionActions(
                    actions?.actions ?? [],
                    signedIn
                  ).filter(
                    (action) =>
                      !(showCodexDeviceLogin && action.kind === 'login')
                  )}
                  extraActions={
                    kindOptions.length > 1 ? (
                      <div className="agent-auth-mode-submodes">
                        {kindOptions.map((option) => (
                          <SubmodeButton
                            key={option.value}
                            option={option}
                            active={option.value === mode}
                            disabled={saving}
                            onSelect={() => void selectMode(option.value)}
                          />
                        ))}
                      </div>
                    ) : null
                  }
                  hideWhenEmpty={showCodexDeviceLogin}
                  busy={busy}
                  saved={view.mode === mode}
                  running={actionRunning}
                  onRunAction={onRunAction}
                />
              ) : null}
            </div>

            {configuration ? (
              <div
                className="agent-auth-mode-panel agent-auth-mode-panel-config"
                hidden={panel !== 'configuration'}
              >
                {typeof configuration === 'function'
                  ? configuration(mode)
                  : configuration}
              </div>
            ) : null}

            {modelProvider ? (
              <div
                className="agent-auth-mode-panel"
                hidden={panel !== 'provider'}
              >
                {withProviderChanged(modelProvider, () => void load())}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SubmodeButton({
  option,
  active,
  disabled,
  onSelect,
}: {
  option: AgentAuthModeOptionView;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <button
      type="button"
      className={cn('agent-auth-mode-submode', active && 'is-active')}
      disabled={disabled}
      onClick={onSelect}
    >
      {t(option.label_key)}
    </button>
  );
}

function AccountSessionBar({
  signedIn,
  accountLabel,
  actions,
  extraActions = null,
  hideWhenEmpty = false,
  busy,
  saved,
  running,
  onRunAction,
}: {
  signedIn: boolean;
  accountLabel?: string | null;
  actions: AgentManagementActionView[];
  extraActions?: ReactNode;
  hideWhenEmpty?: boolean;
  busy: boolean;
  saved: boolean;
  running: string | null;
  onRunAction?: (actionId: string) => void;
}) {
  const { t } = useTranslation('settings');
  const blockedReason = actions.find(
    (action) => !action.available && action.kind !== 'subscription'
  );
  if (actions.length === 0 && !extraActions && hideWhenEmpty) return null;
  return (
    <div
      className={cn(
        'agent-account-session',
        extraActions && 'has-inline-logins'
      )}
    >
      <div className="agent-account-session-status">
        <AgentAccountIdentity signedIn={signedIn} accountLabel={accountLabel} />
        {blockedReason && !blockedReason.available ? (
          <small>
            {blockedReason.unavailable_reason ?? t('agents.actionUnavailable')}
          </small>
        ) : null}
      </div>
      {actions.length || extraActions ? (
        <div className="agent-account-session-actions">
          {extraActions}
          {actions.map((action) => {
            const Icon = managementActionIcon(action.kind);
            const localizedLabel = t(action.label_key, {
              defaultValue: action.label,
            });
            return (
              <Button
                key={action.id}
                size="sm"
                variant={
                  action.kind === 'login'
                    ? 'default'
                    : action.kind === 'logout'
                      ? 'ghost'
                      : 'outline'
                }
                className={cn(
                  'h-8 shrink-0',
                  action.kind === 'logout' && 'text-destructive'
                )}
                title={t(action.description_key, {
                  defaultValue: action.description,
                })}
                aria-label={localizedLabel}
                disabled={
                  busy || !saved || !action.available || running !== null
                }
                onClick={() => onRunAction?.(action.id)}
              >
                {running === action.id ? (
                  <Loader2
                    aria-hidden="true"
                    className="mr-1.5 h-3.5 w-3.5 animate-spin"
                  />
                ) : action.kind === 'subscription' ? (
                  <ExternalLink
                    aria-hidden="true"
                    className="mr-1.5 h-3.5 w-3.5"
                  />
                ) : (
                  <Icon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                )}
                {localizedLabel}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const AUTH_KIND_ORDER: AgentAuthModeKind[] = [
  'subscription',
  'official_api',
  'provider',
];

type AuthenticationPanel = 'account' | 'configuration' | 'provider';

function withProviderChanged(
  node: ReactNode,
  onChanged: () => void
): ReactNode {
  if (
    !isValidElement<{ onChanged?: () => void | Promise<void> }>(node) ||
    typeof node.type === 'string'
  ) {
    return node;
  }
  const previous = node.props.onChanged;
  return cloneElement(node, {
    onChanged: () => {
      void previous?.();
      onChanged();
    },
  });
}

function authenticationPanel(
  kind: AgentAuthModeKind,
  hasModelProvider: boolean
): AuthenticationPanel {
  if (kind === 'provider')
    return hasModelProvider ? 'provider' : 'configuration';
  if (kind === 'subscription') return 'account';
  return 'configuration';
}

function kindOfMode(mode: string): AgentAuthModeKind {
  if (mode === 'model_provider' || mode === 'custom') return 'provider';
  if (
    mode === 'subscription' ||
    mode.endsWith('_subscription') ||
    mode === 'login_google' ||
    mode === 'oauth-personal' ||
    mode === 'oauth-business'
  ) {
    return 'subscription';
  }
  return 'official_api';
}

function persistsImmediately(
  option: AgentAuthModeOptionView | undefined,
  credentialAvailable: boolean,
  savedMode: string
): boolean {
  if (!option) return false;
  if (savedMode === 'model_provider') {
    return false;
  }
  if (option.kind === 'provider' || option.kind === 'official_api') {
    return false;
  }
  if (option.kind === 'subscription') {
    return true;
  }
  if (!option.credential_required) return true;
  return credentialAvailable;
}

function credentialIsAvailable(
  view: AgentAuthModeView | null,
  option: AgentAuthModeOptionView | undefined,
  apiKey: string,
  nativeCredentialPresent?: (fieldId: string) => boolean
): boolean {
  if (!option) return false;
  const alreadyPresent = Boolean(
    view && view.mode === option.value && view.credential_present
  );
  return (
    alreadyPresent ||
    Boolean(
      option.native_config_field_id &&
        nativeCredentialPresent?.(option.native_config_field_id)
    ) ||
    Boolean(apiKey.trim())
  );
}

function accountSessionActive(
  authentication: AgentAuthenticationStatus | undefined
): boolean {
  return authentication === 'account' || authentication === 'multiple_unknown';
}

function sessionActions(
  actions: AgentManagementActionView[],
  signedIn: boolean
): AgentManagementActionView[] {
  return actions.filter((action) => {
    if (action.kind === 'login') return !signedIn;
    if (action.kind === 'logout' || action.kind === 'subscription') {
      return signedIn;
    }
    return false;
  });
}

function authKindTabId(agentId: AgentId, kind: AgentAuthModeKind) {
  return `${agentId}-auth-kind-${kind}`;
}

function authKindTabLabelKey(kind: AgentAuthModeKind): string {
  switch (kind) {
    case 'subscription':
      return 'settings:agents.authModeTabOfficialSubscription';
    case 'official_api':
      return 'settings:agents.authModeTabOfficialApi';
    case 'provider':
      return 'settings:agents.authModeTabProvider';
  }
}

function agentDisplayName(agentId: AgentId) {
  switch (agentId) {
    case 'grok':
      return 'Grok';
    case 'codex':
      return 'Codex';
    case 'claude_code':
      return 'Claude Code';
    case 'antigravity':
    case 'gemini':
      return 'Google Antigravity';
    case 'deepseek_harness':
      return 'DeepSeek Harness';
    case 'opencode':
      return 'OpenCode';
    case 'hermes':
      return 'Hermes';
    case 'kimi_code':
      return 'Kimi Code';
    case 'cline':
      return 'Cline';
    case 'codebuddy':
      return 'CodeBuddy';
    case 'pi':
      return 'Pi';
    case 'openclaw':
      return 'OpenClaw';
    case 'cursor':
      return 'Cursor';
    case 'qoder':
      return 'Qoder';
    default:
      return agentId;
  }
}

function managementActionIcon(kind: AgentManagementActionKind) {
  switch (kind) {
    case 'login':
      return LogIn;
    case 'logout':
      return LogOut;
    case 'setup':
      return Settings2;
    case 'subscription':
      return CreditCard;
  }
}
