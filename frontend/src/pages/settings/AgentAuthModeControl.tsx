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
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentAuthModeView,
  AgentId,
  AgentManagementActionKind,
  AgentManagementActionsView,
} from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import { CodexDeviceLogin } from './CodexDeviceLogin';

type Props = {
  agentId: AgentId;
  actions?: AgentManagementActionsView | null;
  actionRunning?: string | null;
  busy?: boolean;
  configuration?: ReactNode;
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
  busy = false,
  configuration,
  modelProvider,
  nativeCredentialPresent,
  onChanged,
  onDirtyChange,
  onAuthenticated,
  onRunAction,
}: Props) {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<AgentAuthModeView | null>(null);
  const [mode, setMode] = useState('subscription');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await agentManagementApi.authMode(agentId);
      setView(next);
      setMode(next.mode);
    } catch (error) {
      const message = errorMessage(error, t('agents.authLoadFailed'));
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [agentId, t]);

  useEffect(() => void load(), [load]);
  const dirty = Boolean(view && (mode !== view.mode || apiKey.length > 0));
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const save = async () => {
    setSaving(true);
    try {
      const next = await agentManagementApi.setAuthMode(
        agentId,
        mode,
        apiKey.trim() || null
      );
      setView(next);
      setMode(next.mode);
      setApiKey('');
      toast.success(t('agents.authSaved'));
      await onChanged?.();
    } catch (error) {
      toast.error(errorMessage(error, t('agents.authSaveFailed')));
    } finally {
      setSaving(false);
    }
  };

  const selectedOption = view?.options.find((option) => option.value === mode);
  const requiresCredential = selectedOption?.credential_required ?? false;
  const credentialEnv = selectedOption?.credential_env ?? 'API_KEY';
  const nativeConfigFieldId = selectedOption?.native_config_field_id ?? null;
  const credentialAlreadyPresent =
    view?.mode === mode && view.credential_present;
  const credentialAvailable =
    credentialAlreadyPresent ||
    Boolean(
      nativeConfigFieldId && nativeCredentialPresent?.(nativeConfigFieldId)
    ) ||
    Boolean(apiKey.trim());
  const panel = authenticationPanel(mode);
  const displayName =
    agentId === 'grok'
      ? 'Grok'
      : agentId === 'codex'
        ? 'Codex'
        : agentId === 'claude_code'
          ? 'Claude Code'
          : agentId === 'gemini'
            ? 'Gemini'
            : 'Cursor';

  return (
    <section
      aria-labelledby={`${agentId}-auth-mode-heading`}
      className="settings-surface agent-auth-mode-surface"
    >
      <div className="agent-section-heading">
        <div className="flex items-center gap-2">
          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
          <h3 id={`${agentId}-auth-mode-heading`}>{t('agents.authTitle')}</h3>
        </div>
      </div>

      {loading && !view ? (
        <p className="agent-auth-mode-loading" aria-live="polite">
          {t('agents.authLoading')}
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
            {t('agents.retryRead')}
          </Button>
        </div>
      ) : view ? (
        <div className="agent-auth-mode-body">
          <div className="agent-auth-mode-selector">
            <label className="agent-auth-mode-field">
              <span>{t('agents.authModeLabel', { agent: displayName })}</span>
              <AstryxSelect
                ariaLabel={t('agents.authModeAria', { agent: displayName })}
                value={mode}
                options={view.options.map((option) => ({
                  value: option.value,
                  label: t(option.label_key),
                }))}
                onChange={(nextMode) => {
                  setMode(nextMode);
                  const nextOption = view.options.find(
                    (option) => option.value === nextMode
                  );
                  if (
                    !nextOption?.credential_required ||
                    nextOption.native_config_field_id
                  ) {
                    setApiKey('');
                  }
                }}
              />
            </label>
            <Button
              className="h-8 shrink-0"
              disabled={saving || (requiresCredential && !credentialAvailable)}
              size="sm"
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
              ) : null}
              {saving ? t('agents.saving') : t('agents.authSave')}
            </Button>
          </div>

          {requiresCredential &&
          !nativeConfigFieldId &&
          panel === 'configuration' ? (
            <label className="agent-auth-mode-field agent-auth-mode-credential">
              <span>{credentialEnv}</span>
              <div className="agent-auth-mode-secret">
                <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
                <Input
                  aria-label={credentialEnv}
                  autoComplete="new-password"
                  className="agent-auth-mode-secret-input"
                  name={`${agentId}_api_key`}
                  placeholder={
                    credentialAlreadyPresent
                      ? t('agents.credentialSavedPlaceholder')
                      : t('agents.credentialPlaceholder')
                  }
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </div>
            </label>
          ) : null}

          <div className="agent-auth-mode-panel" hidden={panel !== 'account'}>
            {agentId === 'codex' ? (
              <CodexDeviceLogin onAuthenticated={onAuthenticated} />
            ) : null}
            {actions?.actions.length ? (
              <ul className="agent-account-actions">
                {actions.actions.map((action) => {
                  const Icon = managementActionIcon(action.kind);
                  const localizedLabel = t(action.label_key, {
                    defaultValue: action.label,
                  });
                  return (
                    <li key={action.id}>
                      <div className="agent-account-action-copy">
                        <span className="agent-account-action-icon">
                          <Icon aria-hidden="true" className="h-4 w-4" />
                        </span>
                        <span>
                          <strong>{localizedLabel}</strong>
                          {!action.available ? (
                            <small>{t('agents.actionUnavailable')}</small>
                          ) : null}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant={
                          action.kind === 'login' ? 'default' : 'outline'
                        }
                        className="h-8 shrink-0"
                        aria-label={localizedLabel}
                        disabled={
                          busy ||
                          view.mode !== mode ||
                          !action.available ||
                          actionRunning !== null
                        }
                        onClick={() => onRunAction?.(action.id)}
                      >
                        {actionRunning === action.id ? (
                          <Loader2
                            aria-hidden="true"
                            className="mr-1.5 h-3.5 w-3.5 animate-spin"
                          />
                        ) : action.kind === 'subscription' ? (
                          <ExternalLink
                            aria-hidden="true"
                            className="mr-1.5 h-3.5 w-3.5"
                          />
                        ) : null}
                        {localizedLabel}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>

          {configuration ? (
            <div
              className="agent-auth-mode-panel agent-auth-mode-panel-config"
              hidden={panel !== 'configuration'}
            >
              {configuration}
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

type AuthenticationPanel = 'account' | 'configuration' | 'provider';

function authenticationPanel(mode: string): AuthenticationPanel {
  if (mode === 'model_provider') return 'provider';
  if (
    mode === 'subscription' ||
    mode.endsWith('_subscription') ||
    mode === 'login_google'
  ) {
    return 'account';
  }
  return 'configuration';
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
