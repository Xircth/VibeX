import { KeyRound, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

export const QODER_PERSONAL_ACCESS_TOKEN = 'QODER_PERSONAL_ACCESS_TOKEN';

type Props = {
  locked?: boolean;
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

export function QoderLaunchTokenField({
  locked = false,
  onChanged,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation('settings');
  const [revision, setRevision] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const dirty = token.trim().length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const view = await agentManagementApi.environment('qoder');
      const entry = view.entries.find(
        (item) => item.name === QODER_PERSONAL_ACCESS_TOKEN
      );
      setRevision(view.revision);
      setPresent(Boolean(entry?.present));
      setToken('');
    } catch (cause) {
      toast.error(errorMessage(cause, t('agents.qoderTokenLoadFailed')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const persist = async (nextToken: string | null) => {
    if (!revision || locked) return;
    setSaving(true);
    try {
      const next = await agentManagementApi.writeEnvironment({
        agent_id: 'qoder',
        base_revision: revision,
        values: {
          [QODER_PERSONAL_ACCESS_TOKEN]: nextToken,
        },
      });
      setRevision(next.revision);
      setPresent(
        next.entries.some(
          (entry) => entry.name === QODER_PERSONAL_ACCESS_TOKEN && entry.present
        )
      );
      setToken('');
      toast.success(t('agents.qoderTokenSaved'));
      await onChanged?.();
    } catch (cause) {
      toast.error(errorMessage(cause, t('agents.qoderTokenSaveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="agent-auth-mode-field agent-auth-mode-credential">
      <span>{t('agents.qoderTokenLabel')}</span>
      <div className="agent-auth-mode-secret-row">
        <div className="agent-auth-mode-secret">
          <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
          <Input
            aria-label={t('agents.qoderTokenLabel')}
            autoComplete="new-password"
            className="agent-auth-mode-secret-input"
            disabled={loading || saving || locked}
            name="qoder_personal_access_token"
            placeholder={
              present
                ? t('agents.credentialSavedPlaceholder')
                : t('agents.qoderTokenPlaceholder')
            }
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <Button
          className="h-8 shrink-0"
          disabled={loading || saving || locked || !dirty}
          size="sm"
          onClick={() => void persist(token.trim())}
        >
          {saving ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          {saving ? t('agents.saving') : t('agents.qoderTokenSave')}
        </Button>
        {present ? (
          <Button
            className="h-8 shrink-0"
            disabled={loading || saving || locked}
            size="sm"
            variant="ghost"
            onClick={() => void persist(null)}
          >
            {t('agents.qoderTokenClear')}
          </Button>
        ) : null}
      </div>
      <small>{t('agents.qoderTokenHint')}</small>
    </label>
  );
}
