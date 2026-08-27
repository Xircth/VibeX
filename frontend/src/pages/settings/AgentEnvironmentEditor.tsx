import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentEnvironmentPatchRequest,
  AgentEnvironmentView,
  AgentId,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage,
} from '@/features/agent-management';

import { AgentSectionHeading } from './SettingsSection';
import { SettingsActionBar } from './SettingsUi';

type Props = {
  agentId: AgentId;
  disabled?: boolean;
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

export type EnvironmentRow = {
  key: number;
  originalName: string | null;
  name: string;
  value: string;
  secret: boolean;
};

export function AgentEnvironmentEditor({
  agentId,
  disabled = false,
  onChanged,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation('settings');
  const nextKey = useRef(1);
  const [view, setView] = useState<AgentEnvironmentView | null>(null);
  const [rows, setRows] = useState<EnvironmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const adopt = useCallback((next: AgentEnvironmentView) => {
    setView(next);
    setRows(
      next.entries.map((entry) => ({
        key: nextKey.current++,
        originalName: entry.name,
        name: entry.name,
        value: entry.value ?? '',
        secret: entry.secret,
      }))
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      adopt(await agentManagementApi.environment(agentId));
    } catch (cause) {
      setError(
        agentManagementErrorMessage(cause, t('agents.environmentLoadFailed'))
      );
    } finally {
      setLoading(false);
    }
  }, [adopt, agentId, t]);

  useEffect(() => void load(), [load]);

  const request = useMemo(
    () => (view ? buildEnvironmentPatch(view, rows) : null),
    [rows, view]
  );
  const structureDirty = Boolean(
    view &&
      (rows.length !== view.entries.length ||
        rows.some((row) => row.originalName !== row.name.trim()))
  );
  const dirty = Boolean(
    request && (structureDirty || Object.keys(request.values).length > 0)
  );
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const updateRow = (key: number, field: 'name' | 'value', value: string) => {
    setRows((current) =>
      current.map((row) =>
        row.key === key
          ? {
              ...row,
              [field]: value,
              secret:
                field === 'name' && row.originalName === null
                  ? looksLikeSecret(value)
                  : row.secret,
            }
          : row
      )
    );
  };

  const save = async () => {
    if (!request) return;
    const names = rows.map((row) => row.name.trim());
    if (names.some((name) => !validEnvironmentName(name))) {
      setError(t('agents.environmentInvalidName'));
      return;
    }
    if (new Set(names).size !== names.length) {
      setError(t('agents.environmentDuplicateName'));
      return;
    }
    const missingRenamedSecret = rows.some(
      (row) =>
        row.secret &&
        row.originalName !== row.name.trim() &&
        row.value.length === 0
    );
    if (missingRenamedSecret) {
      setError(t('agents.environmentSecretRenameRequiresValue'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      adopt(await agentManagementApi.writeEnvironment(request));
      toast.success(t('agents.environmentSaved'));
      await onChanged?.();
    } catch (cause) {
      const message = agentManagementErrorMessage(
        cause,
        t('agents.environmentSaveFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby={`${agentId}-environment-heading`}
      className="settings-surface"
    >
      <AgentSectionHeading
        headingId={`${agentId}-environment-heading`}
        title={t('agents.environmentTitle')}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        summary={t('agents.environmentCount', { count: rows.length })}
      >
        <Button
          className="h-8"
          disabled={disabled || loading || saving}
          size="sm"
          variant="outline"
          onClick={() => {
            setExpanded(true);
            setRows((current) => [
              ...current,
              {
                key: nextKey.current++,
                originalName: null,
                name: '',
                value: '',
                secret: false,
              },
            ]);
          }}
        >
          <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {t('agents.environmentAdd')}
        </Button>
      </AgentSectionHeading>

      {expanded ? (
        <div className="space-y-2 px-4 pb-4">
          {loading && !view ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin"
              />
              {t('agents.environmentLoading')}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('agents.environmentEmpty')}
            </p>
          ) : (
            rows.map((row, index) => (
              <div
                className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(12rem,1fr)_auto]"
                key={row.key}
              >
                <label
                  className="sr-only"
                  htmlFor={`environment-name-${row.key}`}
                >
                  {t('agents.runtimeEnvironmentNameAria', { index: index + 1 })}
                </label>
                <input
                  aria-label={t('agents.runtimeEnvironmentNameAria', {
                    index: index + 1,
                  })}
                  autoComplete="off"
                  className="raised-control min-w-0 px-2.5 text-xs"
                  disabled={disabled || saving}
                  id={`environment-name-${row.key}`}
                  name={`agent_environment_name_${row.key}`}
                  placeholder="NAME"
                  value={row.name}
                  onChange={(event) =>
                    updateRow(row.key, 'name', event.target.value)
                  }
                />
                <input
                  aria-label={t('agents.runtimeEnvironmentValueAria', {
                    name: row.name || index + 1,
                  })}
                  autoComplete={row.secret ? 'new-password' : 'off'}
                  className="raised-control min-w-0 px-2.5 text-xs"
                  disabled={disabled || saving}
                  name={`agent_environment_value_${row.key}`}
                  placeholder={
                    row.secret && row.originalName
                      ? t('agents.environmentSecretSaved')
                      : t('agents.environmentValuePlaceholder')
                  }
                  type={row.secret ? 'password' : 'text'}
                  value={row.value}
                  onChange={(event) =>
                    updateRow(row.key, 'value', event.target.value)
                  }
                />
                <Button
                  aria-label={t('agents.environmentRemoveAria', {
                    name: row.name || index + 1,
                  })}
                  className="h-8 w-8 p-0"
                  disabled={disabled || saving}
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setRows((current) =>
                      current.filter((candidate) => candidate.key !== row.key)
                    )
                  }
                >
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
          {error ? (
            <p className="agent-inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {view ? (
        <SettingsActionBar
          dirty={dirty}
          disabled={disabled || saving || !dirty}
          saving={saving}
          onDiscard={() => adopt(view)}
          onSave={() => void save()}
        />
      ) : null}
    </section>
  );
}

export function buildEnvironmentPatch(
  view: AgentEnvironmentView,
  rows: EnvironmentRow[]
): AgentEnvironmentPatchRequest {
  const values: Record<string, string | null> = {};
  const currentNames = new Set(rows.map((row) => row.name.trim()));
  for (const entry of view.entries) {
    if (!currentNames.has(entry.name)) values[entry.name] = null;
  }
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const original = view.entries.find((entry) => entry.name === name);
    if (!original || row.value !== (original.value ?? '')) {
      if (!(original?.secret && row.value.length === 0)) {
        values[name] = row.value;
      }
    }
  }
  return {
    agent_id: view.agent_id,
    base_revision: view.revision,
    values,
  };
}

function validEnvironmentName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name);
}

function looksLikeSecret(name: string): boolean {
  return /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)/iu.test(
    name
  );
}
