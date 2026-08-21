import {
  CreditCard,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
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
  nativeCredentialPresent?: (fieldId: string) => boolean;
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onAuthenticated?: () => void;
  onRunAction?: (actionId: string) => void;
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
  nativeCredentialPresent,
  onChanged,
  onDirtyChange,
  onAuthenticated,
  onRunAction,
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
  const requiresCredential = selectedOption?.credential_required ?? false;
  const credentialEnv = selectedOption?.credential_env ?? 'API_KEY';
  const nativeConfigFieldId = selectedOption?.native_config_field_id ?? null;
  const credentialAvailable = credentialIsAvailable(
    view,
    selectedOption,
    apiKey,
    nativeCredentialPresent
  );
  const dirty = Boolean(view && (mode !== view.mode || apiKey.length > 0));
  const panel = authenticationPanel(mode);
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
    if (dirty) retainAgentSettingsDraft(key, { mode, apiKey });
    else clearAgentSettingsDraft(key);
  }, [agentId, apiKey, dirty, mode, view]);

  const persistMode = useCallback(
    async (nextMode: string, nextApiKey = '') => {
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
    [agentId, t, view?.mode]
  );

  useEffect(() => {
    if (!view || saving || loading) return;
    if (mode === view.mode) {
      autoPersisted.current = null;
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

  const selectMode = async (nextMode: string) => {
    if (!view || nextMode === mode || saving) return;
    const nextOption = view.options.find((option) => option.value === nextMode);
    const nextAvailable = credentialIsAvailable(
      view,
      nextOption,
      apiKey,
      nativeCredentialPresent
    );
    if (view.credential_present && isAccountMode(nextMode)) {
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
    if (persistsImmediately(nextOption, nextAvailable)) {
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

  const moveTabFocus = (current: string, delta: number) => {
    if (!view) return;
    const index = view.options.findIndex((option) => option.value === current);
    const next =
      view.options[(index + delta + view.options.length) % view.options.length];
    document.getElementById(authModeTabId(agentId, next.value))?.focus();
  };

  return (
    <section
      aria-labelledby={`${agentId}-auth-mode-heading`}
      className="settings-surface agent-auth-mode-surface"
    >
      <div className="agent-section-heading">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
          <h3 id={`${agentId}-auth-mode-heading`}>
            {t('settings:agents.authTitle')}
          </h3>
        </div>
        <div className="agent-auth-mode-heading-tools">
          {panel === 'configuration' ? headingExtra : null}
          {view ? (
            <div
              className="agent-auth-mode-tabs"
              role="tablist"
              aria-label={t('settings:agents.authModeAria', {
                agent: displayName,
              })}
            >
              {view.options.map((option) => {
                const selected = option.value === mode;
                const draft = selected && option.value !== view.mode;
                const fullLabel = t(option.label_key);
                return (
                  <button
                    key={option.value}
                    id={authModeTabId(agentId, option.value)}
                    type="button"
                    role="tab"
                    aria-label={fullLabel}
                    aria-selected={selected}
                    aria-controls={`${agentId}-auth-mode-panel`}
                    tabIndex={selected ? 0 : -1}
                    className={cn(selected && 'is-active', draft && 'is-draft')}
                    disabled={saving}
                    onClick={() => void selectMode(option.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        moveTabFocus(option.value, 1);
                      } else if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        moveTabFocus(option.value, -1);
                      } else if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void selectMode(option.value);
                      }
                    }}
                  >
                    {t(authModeTabLabelKey(agentId, option))}
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
          role="tabpanel"
        >
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
            {panel === 'account' ? (
              <AccountSessionBar
                signedIn={signedIn}
                accountLabel={view?.account_label}
                actions={sessionActions(
                  actions?.actions ?? [],
                  signedIn
                ).filter(
                  (action) => !(showCodexDeviceLogin && action.kind === 'login')
                )}
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
              {modelProvider}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AccountSessionBar({
  signedIn,
  accountLabel,
  actions,
  hideWhenEmpty = false,
  busy,
  saved,
  running,
  onRunAction,
}: {
  signedIn: boolean;
  accountLabel?: string | null;
  actions: AgentManagementActionView[];
  hideWhenEmpty?: boolean;
  busy: boolean;
  saved: boolean;
  running: string | null;
  onRunAction?: (actionId: string) => void;
}) {
  const { t } = useTranslation('settings');
  const sessionStatus = signedIn
    ? accountLabel
      ? t('agents.authSessionAccount', { account: accountLabel })
      : t('agents.authSessionSignedIn')
    : t('agents.authSessionSignedOut');
  const blockedReason = actions.find(
    (action) => !action.available && action.kind !== 'subscription'
  );
  if (actions.length === 0 && hideWhenEmpty) return null;
  if (actions.length === 0 && !blockedReason) {
    return (
      <div className="agent-account-session">
        <p className="agent-account-session-status">{sessionStatus}</p>
      </div>
    );
  }
  return (
    <div className="agent-account-session">
      <p className="agent-account-session-status">
        <span>{sessionStatus}</span>
        {blockedReason && !blockedReason.available ? (
          <small>
            {blockedReason.unavailable_reason ?? t('agents.actionUnavailable')}
          </small>
        ) : null}
      </p>
      {actions.length ? (
        <div className="agent-account-session-actions">
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

type AuthenticationPanel = 'account' | 'configuration' | 'provider';

function authenticationPanel(mode: string): AuthenticationPanel {
  if (mode === 'model_provider') return 'provider';
  if (isAccountMode(mode)) return 'account';
  return 'configuration';
}

function isAccountMode(mode: string): boolean {
  return (
    mode === 'subscription' ||
    mode.endsWith('_subscription') ||
    mode === 'login_google'
  );
}

function persistsImmediately(
  option: AgentAuthModeOptionView | undefined,
  credentialAvailable: boolean
): boolean {
  if (!option) return false;
  if (isAccountMode(option.value) || option.value === 'model_provider') {
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

function authModeTabId(agentId: AgentId, mode: string) {
  return `${agentId}-auth-mode-${mode}`;
}

function authModeTabLabelKey(
  agentId: AgentId,
  option: AgentAuthModeOptionView
): string {
  switch (option.value) {
    case 'subscription':
    case 'official_subscription':
      return 'settings:agents.authModeTabSubscription';
    case 'chatgpt_subscription':
      return 'settings:agents.authModeTabChatGpt';
    case 'model_provider':
      return 'settings:agents.authModeTabProvider';
    case 'login_google':
      return 'settings:agents.authModeTabGoogle';
    case 'gemini_api_key':
      return 'settings:agents.authModeTabGeminiKey';
    case 'vertex_adc':
      return 'settings:agents.authModeTabVertexAdc';
    case 'vertex_service_account':
      return 'settings:agents.authModeTabVertexSa';
    case 'vertex_api_key':
      return 'settings:agents.authModeTabVertexKey';
    case 'api_key':
      return 'settings:agents.authModeTabApiKey';
    case 'custom':
      return agentId === 'cursor'
        ? 'settings:agents.authModeTabApiKey'
        : 'settings:agents.authModeTabCustom';
    case 'deepseek':
      return 'settings:agents.authModeTabDeepseek';
    default:
      return option.label_key;
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
    case 'gemini':
      return 'Gemini';
    case 'deepseek_harness':
      return 'DeepSeek Harness';
    default:
      return 'Cursor';
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
