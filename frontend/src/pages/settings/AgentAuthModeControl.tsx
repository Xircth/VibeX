import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentAuthModeView, AgentId } from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

type Props = {
  agentId: AgentId;
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

export function AgentAuthModeControl({
  agentId,
  onChanged,
  onDirtyChange,
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
  const credentialAlreadyPresent =
    view?.mode === mode && view.credential_present;
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
          <div>
            <h3 id={`${agentId}-auth-mode-heading`}>{t('agents.authTitle')}</h3>
            <p className="agent-section-caption">{t('agents.authCaption')}</p>
          </div>
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
          <label className="agent-auth-mode-field">
            <span>{t('agents.authModeLabel', { agent: displayName })}</span>
            <select
              aria-label={t('agents.authModeAria', { agent: displayName })}
              className="raised-control"
              name={`${agentId}_auth_mode`}
              value={mode}
              onChange={(event) => {
                const nextMode = event.target.value;
                setMode(nextMode);
                if (
                  !view.options.find((option) => option.value === nextMode)
                    ?.credential_required
                ) {
                  setApiKey('');
                }
              }}
            >
              {view.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label_key)}
                </option>
              ))}
            </select>
          </label>

          {requiresCredential ? (
            <label className="agent-auth-mode-field">
              <span>{credentialEnv}</span>
              <div className="agent-auth-mode-secret">
                <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
                <input
                  aria-label={credentialEnv}
                  autoComplete="new-password"
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
          ) : (
            <div className="agent-auth-mode-note">
              <strong>
                {selectedOption
                  ? t(selectedOption.label_key)
                  : t('agents.authModeUnknown')}
              </strong>
              <p>
                {selectedOption
                  ? t(selectedOption.description_key)
                  : t('agents.authDescUnknown')}
              </p>
            </div>
          )}

          <div className="agent-auth-mode-actions" aria-live="polite">
            <span>
              {requiresCredential
                ? selectedOption
                  ? t(selectedOption.description_key)
                  : t('agents.authDescUnknown')
                : t('agents.authNextSession')}
            </span>
            <Button
              className="h-8 shrink-0"
              disabled={
                saving ||
                (requiresCredential &&
                  !credentialAlreadyPresent &&
                  !apiKey.trim())
              }
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
        </div>
      ) : null}
    </section>
  );
}
