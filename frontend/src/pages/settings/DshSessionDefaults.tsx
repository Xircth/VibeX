import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import { AgentSectionHeading } from './SettingsSection';
import { useLiveSettingsCommit } from './useLiveSettingsCommit';

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
  const [revision, setRevision] = useState('');
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [saved, setSaved] = useState<Draft>(DEFAULT_DRAFT);
  const [expanded, setExpanded] = useState(true);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const { writeNow, holding, holdingRef } = useLiveSettingsCommit(
    async (next: Draft) => {
      try {
        const savedEnvironment = await agentManagementApi.writeEnvironment({
          agent_id: 'deepseek_harness',
          base_revision: revisionRef.current,
          values: {
            DSH_AGENT_PRESET: next.preset,
            DEEPSEEK_ACP_SANDBOX: next.sandbox,
            DEEPSEEK_ACP_REASONING: next.reasoning,
          },
        });
        revisionRef.current = savedEnvironment.revision;
        setRevision(savedEnvironment.revision);
        setSaved(next);
        await onChanged?.();
      } catch (error) {
        toast.error(
          errorMessage(error, t('settings:agents.dshSessionSaveFailed'))
        );
      }
    }
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const environment =
        await agentManagementApi.environment('deepseek_harness');
      const values = Object.fromEntries(
        environment.entries.map((entry) => [entry.name, entry.value ?? ''])
      );
      const next = {
        preset: values.DSH_AGENT_PRESET || DEFAULT_DRAFT.preset,
        sandbox: values.DEEPSEEK_ACP_SANDBOX || DEFAULT_DRAFT.sandbox,
        reasoning: values.DEEPSEEK_ACP_REASONING || DEFAULT_DRAFT.reasoning,
      };
      setRevision(environment.revision);
      revisionRef.current = environment.revision;
      if (!holdingRef.current) {
        draftRef.current = next;
        setDraft(next);
        setSaved(next);
      }
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshSessionLoadFailed'))
      );
    } finally {
      setLoading(false);
    }
  }, [holdingRef, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    draft.preset !== saved.preset ||
    draft.sandbox !== saved.sandbox ||
    draft.reasoning !== saved.reasoning;

  useEffect(() => {
    onDirtyChange?.(holding ? false : dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, holding, onDirtyChange]);

  const updateDraft = (patch: Partial<Draft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    onDirtyChangeRef.current?.(false);
    writeNow(next);
  };

  return (
    <>
      <section
        aria-labelledby="dsh-session-heading"
        className="settings-surface"
      >
        <AgentSectionHeading
          headingId="dsh-session-heading"
          title={t('settings:agents.configTitle')}
          expanded={expanded}
          onToggle={() => setExpanded((current) => !current)}
          summary={t('agents.configFieldCount', { count: 3 })}
        />
        {expanded ? (
          loading ? (
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
                      aria-label={t(`settings:agents.dshPreset.${id}.name`)}
                      className="dsh-preset-card"
                      data-selected={selected ? 'true' : 'false'}
                      role="radio"
                      type="button"
                      onClick={() => updateDraft({ preset: id })}
                    >
                      <div className="dsh-preset-card-head">
                        <strong>
                          {t(`settings:agents.dshPreset.${id}.name`)}
                        </strong>
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
                    onChange={(sandbox) => updateDraft({ sandbox })}
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
                    onChange={(reasoning) => updateDraft({ reasoning })}
                  />
                </label>
              </div>
            </div>
          )
        ) : null}
      </section>
    </>
  );
}
