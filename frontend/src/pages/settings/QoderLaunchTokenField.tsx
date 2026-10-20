import { KeyRound, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentId } from 'shared/types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

export const QODER_PERSONAL_ACCESS_TOKEN = 'QODER_PERSONAL_ACCESS_TOKEN';

type Props = {
  agentId: AgentId;
  envName: string;
  locked?: boolean;
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

export function HeadlessAccountTokenField({
  agentId,
  envName,
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
      const view = await agentManagementApi.environment(agentId);
      const entry = view.entries.find((item) => item.name === envName);
      setRevision(view.revision);
      setPresent(Boolean(entry?.present));
      setToken('');
    } catch (cause) {
      toast.error(
        errorMessage(cause, t('agents.headlessAccountTokenLoadFailed'))
      );
    } finally {
      setLoading(false);
    }
  }, [agentId, envName, t]);

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
        agent_id: agentId,
        base_revision: revision,
        values: {
          [envName]: nextToken,
        },
      });
      setRevision(next.revision);
      setPresent(
        next.entries.some((entry) => entry.name === envName && entry.present)
      );
      setToken('');
      toast.success(t('agents.headlessAccountTokenSaved'));
      await onChanged?.();
    } catch (cause) {
      toast.error(
        errorMessage(cause, t('agents.headlessAccountTokenSaveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <label className="agent-auth-mode-field agent-auth-mode-credential">
      <span>{envName}</span>
      <div className="agent-auth-mode-secret-row">
        <div className="agent-auth-mode-secret">
          <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
          <Input
            aria-label={envName}
            autoComplete="new-password"
            className="agent-auth-mode-secret-input"
            disabled={loading || saving || locked}
            name={`${agentId}_headless_account_token`}
            placeholder={
              present
                ? t('agents.credentialSavedPlaceholder')
                : t('agents.credentialPlaceholder')
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
          {saving ? t('agents.saving') : t('agents.authSave')}
        </Button>
        {present ? (
          <Button
            className="h-8 shrink-0"
            disabled={loading || saving || locked}
            size="sm"
            variant="ghost"
            onClick={() => void persist(null)}
          >
            {t('agents.headlessAccountTokenClear')}
          </Button>
        ) : null}
      </div>
      <small>{t('agents.headlessAccountTokenHint')}</small>
    </label>
  );
}

type QoderProps = Omit<Props, 'agentId' | 'envName'>;

export function QoderLaunchTokenField(props: QoderProps) {
  return (
    <HeadlessAccountTokenField
      agentId="qoder"
      envName={QODER_PERSONAL_ACCESS_TOKEN}
      {...props}
    />
  );
}
