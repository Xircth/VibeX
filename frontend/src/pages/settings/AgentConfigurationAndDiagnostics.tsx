import { Eye, FileKey2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  AgentNativeConfigFieldView,
  AgentNativeConfigFileView,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigView,
} from 'shared/types';

import { Button } from '@/components/ui/button';

import { SettingsActionBar } from './SettingsUi';

type Props = {
  config: AgentNativeConfigView | null;
  saving: boolean;
  conflictMessage?: string | null;
  onSave: (request: AgentNativeConfigPatchRequest) => void;
  onReloadConflict?: () => void;
  onAdoptExternal?: () => void;
  onOverwriteConflict?: () => void;
};

export function AgentConfigurationAndDiagnostics({
  config,
  saving,
  conflictMessage,
  onSave,
  onReloadConflict,
  onAdoptExternal,
  onOverwriteConflict,
}: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [removed, setRemoved] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setDrafts(draftsFromConfig(config));
    setDirty({});
    setRemoved({});
  }, [config]);

  const groups = useMemo(
    () => groupFieldsByPath(config?.fields ?? []),
    [config]
  );
  const changedFields = config?.fields.filter((field) => dirty[field.id]) ?? [];
  const canSave = changedFields.some(
    (field) =>
      removed[field.id] || !field.secret || (drafts[field.id] ?? '').length > 0
  );

  const updateDraft = (fieldId: string, value: string) => {
    setDrafts((current) => ({ ...current, [fieldId]: value }));
    setDirty((current) => ({ ...current, [fieldId]: true }));
    setRemoved((current) => ({ ...current, [fieldId]: false }));
  };

  const discard = () => {
    setDrafts(draftsFromConfig(config));
    setDirty({});
    setRemoved({});
  };

  const save = () => {
    if (!config) return;
    const fields = changedFields.filter(
      (field) =>
        removed[field.id] ||
        !field.secret ||
        (drafts[field.id] ?? '').length > 0
    );
    if (fields.length === 0) return;
    onSave({
      agent_id: config.agent_id,
      base_field_revisions: Object.fromEntries(
        fields.map((field) => [field.id, field.revision])
      ),
      fields: Object.fromEntries(
        fields.map((field) => {
          if (removed[field.id]) return [field.id, null];
          const value = drafts[field.id] ?? '';
          return [field.id, value.length > 0 ? value : null];
        })
      ),
    });
  };

  const removeField = (field: AgentNativeConfigFieldView) => {
    if (removed[field.id]) {
      setDrafts((current) => ({
        ...current,
        [field.id]: field.secret ? '' : (field.value ?? ''),
      }));
      setDirty((current) => ({ ...current, [field.id]: false }));
      setRemoved((current) => ({ ...current, [field.id]: false }));
      return;
    }
    setDrafts((current) => ({ ...current, [field.id]: '' }));
    setDirty((current) => ({ ...current, [field.id]: true }));
    setRemoved((current) => ({ ...current, [field.id]: true }));
  };

  return (
    <>
      <section className="settings-surface agent-config-surface">
        <div className="agent-section-heading">
          <div className="flex items-center gap-2">
            <FileKey2 aria-hidden="true" className="h-4 w-4" />
            <h3>配置管理</h3>
          </div>
        </div>

        {conflictMessage ? (
          <div
            className="mx-4 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-warning/10 px-3 py-2 text-xs text-foreground"
            role="alert"
          >
            <span>{conflictMessage}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={onReloadConflict}
              >
                重新加载
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={onAdoptExternal}
              >
                采用外部值
              </Button>
              <Button
                size="sm"
                className="h-7"
                disabled={saving}
                onClick={onOverwriteConflict}
              >
                覆盖外部修改
              </Button>
            </div>
          </div>
        ) : null}

        {!config ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            正在读取配置…
          </p>
        ) : !config.available ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            此 Agent 暂不支持配置文件管理。
          </p>
        ) : (
          <div className="agent-config-groups">
            {groups.map(([path, fields]) => (
              <fieldset className="agent-config-group" key={path}>
                <legend>
                  <span>{fileName(path)}</span>
                  <code>{path}</code>
                </legend>
                <div className="agent-config-grid">
                  {fields.map((field) => (
                    <ConfigField
                      key={field.id}
                      field={field}
                      value={drafts[field.id] ?? ''}
                      removed={removed[field.id] === true}
                      saving={saving}
                      onChange={(value) => updateDraft(field.id, value)}
                      onRemove={() => removeField(field)}
                    />
                  ))}
                </div>
                <ConfigFilePreview
                  file={config.files.find((file) => file.path === path)}
                  path={path}
                />
              </fieldset>
            ))}
          </div>
        )}
      </section>
      {config?.available ? (
        <SettingsActionBar
          dirty={changedFields.length > 0}
          saving={saving}
          disabled={!canSave}
          onDiscard={discard}
          onSave={save}
        />
      ) : null}
    </>
  );
}

function ConfigField({
  field,
  value,
  removed,
  saving,
  onChange,
  onRemove,
}: {
  field: AgentNativeConfigFieldView;
  value: string;
  removed: boolean;
  saving: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const inputId = `agent-config-${field.id}`;
  return (
    <div className="agent-config-field">
      <div className="agent-config-field-label">
        <label htmlFor={inputId}>{field.label}</label>
      </div>
      <div className="agent-config-field-control">
        {field.kind === 'select' ? (
          <select
            id={inputId}
            aria-label={field.label}
            disabled={saving}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">未设置</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : field.kind === 'boolean' ? (
          <label className="agent-config-boolean" htmlFor={inputId}>
            <input
              id={inputId}
              aria-label={field.label}
              checked={value === 'true'}
              disabled={saving}
              type="checkbox"
              onChange={(event) => onChange(String(event.target.checked))}
            />
            <span>{value === 'true' ? '已开启' : '已关闭'}</span>
          </label>
        ) : (
          <input
            id={inputId}
            aria-label={field.label}
            autoComplete="off"
            disabled={saving}
            inputMode={field.kind === 'number' ? 'numeric' : undefined}
            type={
              field.secret
                ? 'password'
                : field.kind === 'number'
                  ? 'number'
                  : 'text'
            }
            value={value}
            placeholder={
              field.secret && field.present ? '输入新值以替换' : '未设置'
            }
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {field.secret && field.present && !removed ? (
          <span className="agent-config-secret-state">
            {field.masked_value ?? '••••••••'}
          </span>
        ) : null}
        {field.present ? (
          <Button
            size="sm"
            variant="ghost"
            className="agent-config-field-remove h-7"
            aria-label={
              removed ? `撤销移除 ${field.label}` : `移除 ${field.label}`
            }
            disabled={saving}
            onClick={onRemove}
          >
            {removed ? '撤销' : '移除'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ConfigFilePreview({
  file,
  path,
}: {
  file: AgentNativeConfigFileView | undefined;
  path: string;
}) {
  const name = fileName(path);
  const sensitive = file?.sensitive === true && file.exists;
  const content = file?.exists ? file.content : '文件尚未创建';
  return (
    <div
      aria-label={
        sensitive ? `${name} 配置文件预览，悬停或聚焦时显示` : undefined
      }
      className={`agent-config-preview${sensitive ? ' is-sensitive' : ''}`}
      tabIndex={sensitive ? 0 : undefined}
    >
      <div className="agent-config-preview-heading">
        <span>配置文件</span>
        <code>{file?.format.toUpperCase() ?? 'FILE'}</code>
      </div>
      <pre aria-hidden={sensitive || undefined}>{content}</pre>
      {sensitive ? (
        <span aria-hidden="true" className="agent-config-preview-mask">
          <Eye className="h-4 w-4" />
          悬停查看
        </span>
      ) : null}
    </div>
  );
}

function draftsFromConfig(
  config: AgentNativeConfigView | null
): Record<string, string> {
  return Object.fromEntries(
    (config?.fields ?? []).map((field) => [
      field.id,
      field.secret ? '' : (field.value ?? ''),
    ])
  );
}

function groupFieldsByPath(
  fields: AgentNativeConfigFieldView[]
): [string, AgentNativeConfigFieldView[]][] {
  const groups = new Map<string, AgentNativeConfigFieldView[]>();
  fields.forEach((field) => {
    const group = groups.get(field.path) ?? [];
    group.push(field);
    groups.set(field.path, group);
  });
  return [...groups.entries()];
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
