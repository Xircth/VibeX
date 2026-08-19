import { Shield } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import { SettingsActionBar } from './SettingsUi';

const PRESETS = ['standard', 'code', 'minimal', 'cordis'] as const;
const SANDBOXES = [
  'workspace-write',
  'read-only',
  'danger-full-access',
] as const;
const REASONING = ['high', 'off', 'max'] as const;

type Draft = {
  preset: string;
  sandbox: string;
  reasoning: string;
};

const DEFAULT_DRAFT: Draft = {
  preset: 'standard',
  sandbox: 'workspace-write',
  reasoning: 'high',
};

type Props = {
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

export function DshSessionDefaults({ onChanged, onDirtyChange }: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState('');
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [saved, setSaved] = useState<Draft>(DEFAULT_DRAFT);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const environment = await agentManagementApi.environment(
        'deepseek_harness'
      );
      const values = Object.fromEntries(
        environment.entries.map((entry) => [entry.name, entry.value ?? ''])
      );
      const next = {
        preset: values.DSH_AGENT_PRESET || DEFAULT_DRAFT.preset,
        sandbox: values.DEEPSEEK_ACP_SANDBOX || DEFAULT_DRAFT.sandbox,
        reasoning: values.DEEPSEEK_ACP_REASONING || DEFAULT_DRAFT.reasoning,
      };
      setDraft(next);
      setSaved(next);
      setRevision(environment.revision);
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshSessionLoadFailed'))
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    draft.preset !== saved.preset ||
    draft.sandbox !== saved.sandbox ||
    draft.reasoning !== saved.reasoning;

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const save = async () => {
    setSaving(true);
    try {
      const next = await agentManagementApi.writeEnvironment({
        agent_id: 'deepseek_harness',
        base_revision: revision,
        values: {
          DSH_AGENT_PRESET: draft.preset,
          DEEPSEEK_ACP_SANDBOX: draft.sandbox,
          DEEPSEEK_ACP_REASONING: draft.reasoning,
        },
      });
      setRevision(next.revision);
      setSaved(draft);
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshSessionSaveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section
        aria-labelledby="dsh-session-heading"
        className="settings-surface"
      >
        <div className="agent-section-heading">
          <div className="flex items-center gap-2">
            <Shield aria-hidden="true" className="h-4 w-4" />
            <h3 id="dsh-session-heading">
              {t('settings:agents.configTitle')}
            </h3>
          </div>
        </div>
        {loading ? (
          <p className="agent-plugin-empty">
            {t('settings:agents.dshSessionLoading')}
          </p>
        ) : (
          <div className="dsh-session-body">
            <div className="dsh-preset-grid" role="radiogroup">
              {PRESETS.map((id) => {
                const selected = draft.preset === id;
                return (
                  <button
                    key={id}
                    aria-checked={selected}
                    className="dsh-preset-card"
                    data-selected={selected ? 'true' : 'false'}
                    role="radio"
                    type="button"
                    onClick={() =>
                      setDraft((current) => ({ ...current, preset: id }))
                    }
                  >
                    <div className="dsh-preset-card-head">
                      <strong>{t(`settings:agents.dshPreset.${id}.name`)}</strong>
                      <span className="dsh-preset-badge">
                        {t('settings:agents.dshPresetBuiltin')}
                      </span>
                      {selected ? (
                        <span className="dsh-preset-badge is-current">
                          {t('settings:agents.dshPresetCurrent')}
                        </span>
                      ) : null}
                    </div>
                    <p>{t(`settings:agents.dshPreset.${id}.summary`)}</p>
                  </button>
                );
              })}
            </div>
            <div className="dsh-session-fields">
              <label className="agent-auth-mode-field">
                <span>{t('settings:agents.dshSessionSandbox')}</span>
                <AstryxSelect
                  ariaLabel={t('settings:agents.dshSessionSandbox')}
                  options={SANDBOXES.map((value) => ({
                    value,
                    label: t(`settings:agents.dshSandbox.${value}`),
                  }))}
                  value={draft.sandbox}
                  onChange={(sandbox) =>
                    setDraft((current) => ({ ...current, sandbox }))
                  }
                />
              </label>
              <label className="agent-auth-mode-field">
                <span>{t('settings:agents.dshSessionReasoning')}</span>
                <AstryxSelect
                  ariaLabel={t('settings:agents.dshSessionReasoning')}
                  options={REASONING.map((value) => ({
                    value,
                    label: t(`settings:agents.dshReasoning.${value}`),
                  }))}
                  value={draft.reasoning}
                  onChange={(reasoning) =>
                    setDraft((current) => ({ ...current, reasoning }))
                  }
                />
              </label>
            </div>
          </div>
        )}
      </section>
      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={() => setDraft(saved)}
        onSave={() => void save()}
      />
    </>
  );
}
