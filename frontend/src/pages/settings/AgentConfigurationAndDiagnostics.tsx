import { FileKey2, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentNativeConfigFieldView,
  AgentNativeConfigFileView,
  AgentNativeConfigFileWriteRequest,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { desktopApi } from '@/lib/api';

import { AgentModelCatalogControl } from './AgentModelCatalogControl';
import { AgentModelProviderManager } from './AgentModelProviderManager';
import { AgentSkillsManager } from './AgentSkillsManager';
import { CodexModelCatalogEditor } from './CodexModelCatalogEditor';
import { PiConfigurationPanel } from './PiConfigurationPanel';
import { PiProviderBuilder } from './PiProviderBuilder';
import { SettingsActionBar } from './SettingsUi';

type Props = {
  config: AgentNativeConfigView | null;
  saving: boolean;
  conflictMessage?: string | null;
  onSave: (request: AgentNativeConfigPatchRequest) => void;
  onSaveFile?: (request: AgentNativeConfigFileWriteRequest) => void;
  onReloadConflict?: () => void;
  onAdoptExternal?: () => void;
  onOverwriteConflict?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function AgentConfigurationAndDiagnostics({
  config,
  saving,
  conflictMessage,
  onSave,
  onSaveFile,
  onReloadConflict,
  onAdoptExternal,
  onOverwriteConflict,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation('settings');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [removed, setRemoved] = useState<Record<string, boolean>>({});
  const [rawDirty, setRawDirty] = useState<Record<string, boolean>>({});
  const [childDirty, setChildDirty] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setDrafts(draftsFromConfig(config));
    setDirty({});
    setRemoved({});
    setRawDirty({});
    setChildDirty({});
  }, [config]);

  const visibleFields = useMemo(
    () => filterVisibleFields(config, drafts),
    [config, drafts]
  );
  const groups = useMemo(
    () => groupFieldsByPath(config, visibleFields),
    [config, visibleFields]
  );
  const changedFields = config?.fields.filter((field) => dirty[field.id]) ?? [];
  const firstConfigPath = config?.paths?.[0];
  const canSave = changedFields.some(
    (field) =>
      removed[field.id] || !field.secret || (drafts[field.id] ?? '').length > 0
  );
  useEffect(() => {
    onDirtyChange?.(
      canSave ||
        Object.values(rawDirty).some(Boolean) ||
        Object.values(childDirty).some(Boolean)
    );
  }, [canSave, childDirty, onDirtyChange, rawDirty]);
  const updateRawDirty = useCallback((path: string, isDirty: boolean) => {
    setRawDirty((current) =>
      current[path] === isDirty ? current : { ...current, [path]: isDirty }
    );
  }, []);
  const updateChildDirty = useCallback((surface: string, isDirty: boolean) => {
    setChildDirty((current) =>
      current[surface] === isDirty
        ? current
        : { ...current, [surface]: isDirty }
    );
  }, []);
  const updateCodexCatalogDirty = useCallback(
    (isDirty: boolean) => updateChildDirty('codex-model-catalog', isDirty),
    [updateChildDirty]
  );
  const updatePiConfigurationDirty = useCallback(
    (isDirty: boolean) => updateChildDirty('pi-configuration', isDirty),
    [updateChildDirty]
  );
  const updateModelProviderDirty = useCallback(
    (isDirty: boolean) => updateChildDirty('model-provider', isDirty),
    [updateChildDirty]
  );
  const updateSkillsDirty = useCallback(
    (isDirty: boolean) => updateChildDirty('skills', isDirty),
    [updateChildDirty]
  );

  const updateDraft = (fieldId: string, value: string) => {
    setDrafts((current) => {
      const next = { ...current, [fieldId]: value };
      if (fieldId === 'codex_approval_policy' && value === 'granular') {
        CODEX_GRANULAR_APPROVAL_FIELDS.forEach((id) => {
          if (!next[id]) next[id] = 'true';
        });
      }
      return next;
    });
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
            <h3>{t('agents.configTitle')}</h3>
          </div>
          {firstConfigPath ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              aria-label={t('agents.openConfigFolder')}
              disabled={saving}
              onClick={() => {
                void desktopApi
                  .revealInFileManager(parentDirectory(firstConfigPath))
                  .catch(() => toast.error(t('agents.openConfigFolderFailed')));
              }}
            >
              <FolderOpen aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              {t('agents.openConfigFolder')}
            </Button>
          ) : null}
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
                {t('agents.reload')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={onAdoptExternal}
              >
                {t('agents.adoptExternal')}
              </Button>
              <Button
                size="sm"
                className="h-7"
                disabled={saving}
                onClick={onOverwriteConflict}
              >
                {t('agents.overwriteExternal')}
              </Button>
            </div>
          </div>
        ) : null}

        {!config ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            {t('agents.configLoading')}
          </p>
        ) : !config.available ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            {t('agents.configUnsupported')}
          </p>
        ) : (
          <>
            {config.settings_features.includes('model_catalog') ? (
              <AgentModelCatalogControl
                agentId={config.agent_id}
                drafts={drafts}
                disabled={saving}
                onSelect={updateDraft}
              />
            ) : null}
            {config.settings_features.includes('codex_model_catalog') ? (
              <CodexModelCatalogEditor
                disabled={saving}
                onDirtyChange={updateCodexCatalogDirty}
              />
            ) : null}
            {config.settings_features.includes('pi_configuration') ? (
              <PiConfigurationPanel
                disabled={saving}
                onDirtyChange={updatePiConfigurationDirty}
              />
            ) : null}
            {config.settings_features.includes('reusable_model_providers') ? (
              <AgentModelProviderManager
                key={config.agent_id}
                agentId={config.agent_id}
                disabled={saving}
                onDirtyChange={updateModelProviderDirty}
              />
            ) : null}
            {config.settings_features.includes('native_skills') ? (
              <AgentSkillsManager
                key={`skills:${config.agent_id}`}
                agentId={config.agent_id}
                disabled={saving}
                onDirtyChange={updateSkillsDirty}
              />
            ) : null}
            <div className="agent-config-groups">
              {groups.map(([path, fields, file]) => (
                <fieldset className="agent-config-group" key={path}>
                  <legend>
                    <span>{fileName(path)}</span>
                    <code>{path}</code>
                  </legend>
                  {fields.length > 0 ? (
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
                  ) : null}
                  <ConfigFileEditor
                    agentId={config.agent_id}
                    file={file}
                    saving={saving}
                    onSave={onSaveFile}
                    onDirtyChange={updateRawDirty}
                  />
                </fieldset>
              ))}
            </div>
          </>
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
  const { t, i18n } = useTranslation('settings');
  const inputId = `agent-config-${field.id}`;
  const labelId = `${inputId}-label`;
  const descriptionId = `${inputId}-description`;
  const english = i18n.resolvedLanguage?.startsWith('en') ?? false;
  const label = english ? humanizeIdentifier(field.id) : field.label;
  const description = english
    ? t('agents.nativeConfigFieldDescription', { label })
    : field.description;
  return (
    <div className="agent-config-field">
      <div className="agent-config-field-label">
        {field.id === 'pi_custom_providers' ? (
          <span id={labelId}>{label}</span>
        ) : (
          <label htmlFor={inputId}>{label}</label>
        )}
        <p id={descriptionId}>{description}</p>
      </div>
      <div className="agent-config-field-control">
        {field.id === 'pi_custom_providers' ? (
          <div
            id={inputId}
            aria-describedby={descriptionId}
            aria-labelledby={labelId}
            role="group"
          >
            <PiProviderBuilder
              value={value}
              disabled={saving}
              onChange={onChange}
            />
          </div>
        ) : field.kind === 'json' ? (
          <textarea
            id={inputId}
            aria-label={label}
            aria-describedby={descriptionId}
            autoComplete="off"
            name={`agent_config_${field.id}`}
            disabled={saving}
            rows={7}
            spellCheck={false}
            value={value}
            placeholder="{}"
            onChange={(event) => onChange(event.target.value)}
          />
        ) : field.kind === 'select' ? (
          <select
            id={inputId}
            aria-label={label}
            aria-describedby={descriptionId}
            className="raised-control"
            disabled={saving}
            name={`agent_config_${field.id}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">{t('agents.notSet')}</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {english && containsCjk(option.label)
                  ? humanizeIdentifier(option.value)
                  : option.label}
              </option>
            ))}
          </select>
        ) : field.kind === 'boolean' ? (
          <label className="agent-config-boolean" htmlFor={inputId}>
            <input
              id={inputId}
              aria-label={label}
              aria-describedby={descriptionId}
              checked={value === 'true'}
              disabled={saving}
              name={`agent_config_${field.id}`}
              type="checkbox"
              onChange={(event) => onChange(String(event.target.checked))}
            />
            <span>{value === 'true' ? t('agents.on') : t('agents.off')}</span>
          </label>
        ) : (
          <input
            id={inputId}
            aria-label={label}
            aria-describedby={descriptionId}
            autoComplete={field.secret ? 'new-password' : 'off'}
            disabled={saving}
            inputMode={field.kind === 'number' ? 'numeric' : undefined}
            type={
              field.secret
                ? 'password'
                : field.kind === 'number'
                  ? 'number'
                  : 'text'
            }
            name={`agent_config_${field.id}`}
            value={value}
            placeholder={
              field.secret && field.present
                ? t('agents.replaceSecretPlaceholder')
                : t('agents.notSet')
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
              removed
                ? t('agents.undoRemoveAria', { label })
                : t('agents.removeFieldAria', { label })
            }
            disabled={saving}
            onClick={onRemove}
          >
            {removed ? t('agents.undo') : t('agents.remove')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function humanizeIdentifier(value: string): string {
  const acronyms = new Map([
    ['api', 'API'],
    ['url', 'URL'],
    ['id', 'ID'],
    ['mcp', 'MCP'],
    ['acp', 'ACP'],
    ['http', 'HTTP'],
    ['https', 'HTTPS'],
    ['json', 'JSON'],
    ['oauth', 'OAuth'],
    ['ui', 'UI'],
  ]);
  return value
    .split(/[_-]+/u)
    .filter(Boolean)
    .map(
      (word) =>
        acronyms.get(word.toLowerCase()) ??
        `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`
    )
    .join(' ');
}

function ConfigFileEditor({
  agentId,
  file,
  saving,
  onSave,
  onDirtyChange,
}: {
  agentId: AgentNativeConfigView['agent_id'];
  file: AgentNativeConfigFileView | undefined;
  saving: boolean;
  onSave?: (request: AgentNativeConfigFileWriteRequest) => void;
  onDirtyChange?: (path: string, dirty: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState(file?.content ?? '');
  useEffect(() => setDraft(file?.content ?? ''), [file]);
  const dirty = Boolean(file && !file.sensitive && draft !== file.content);
  useEffect(() => {
    if (file) onDirtyChange?.(file.path, dirty);
  }, [dirty, file, onDirtyChange]);
  const sensitive = file?.sensitive === true && file.exists;
  const content = !file?.exists
    ? t('agents.fileNotCreated')
    : sensitive
      ? t('agents.sensitiveHidden')
      : file.content;
  if (!file || file.sensitive) {
    return (
      <div className="agent-config-preview">
        <div className="agent-config-preview-heading">
          <span>{t('agents.configFile')}</span>
          <code>{file?.format.toUpperCase() ?? 'FILE'}</code>
        </div>
        <pre>{content}</pre>
      </div>
    );
  }

  return (
    <div className="agent-config-preview">
      <div className="agent-config-preview-heading">
        <span>{t('agents.configFile')}</span>
        <code>{file?.format.toUpperCase() ?? 'FILE'}</code>
      </div>
      <pre>{content}</pre>
      <details className="agent-config-raw-editor">
        <summary>{t('agents.advancedFileEditor')}</summary>
        <p>{t('agents.advancedFileEditorHint')}</p>
        <label className="sr-only" htmlFor={`agent-file-${file.path}`}>
          {t('agents.editConfigFileAria', { file: fileName(file.path) })}
        </label>
        <textarea
          id={`agent-file-${file.path}`}
          aria-label={t('agents.editConfigFileAria', {
            file: fileName(file.path),
          })}
          disabled={saving}
          rows={14}
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="agent-config-raw-actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={saving || !dirty}
            onClick={() => setDraft(file.content)}
          >
            {t('agents.resetFile')}
          </Button>
          <Button
            size="sm"
            disabled={saving || !dirty || !onSave}
            onClick={() =>
              onSave?.({
                agent_id: agentId,
                path: file.path,
                base_revision: file.revision,
                content: draft,
              })
            }
          >
            {t('agents.saveFile')}
          </Button>
        </div>
      </details>
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
  config: AgentNativeConfigView | null,
  fields: AgentNativeConfigFieldView[]
): [
  string,
  AgentNativeConfigFieldView[],
  AgentNativeConfigFileView | undefined,
][] {
  const groups = new Map<string, AgentNativeConfigFieldView[]>(
    (config?.files ?? []).map((file) => [file.path, []])
  );
  fields.forEach((field) => {
    const group = groups.get(field.path) ?? [];
    group.push(field);
    groups.set(field.path, group);
  });
  return [...groups.entries()].map(([path, groupedFields]) => [
    path,
    groupedFields,
    config?.files.find((file) => file.path === path),
  ]);
}

const HERMES_PROVIDER_FIELDS: Record<string, string[]> = {
  openrouter: ['hermes_openrouter_key'],
  'openai-api': ['hermes_openai_key', 'hermes_openai_base_url'],
  custom: ['hermes_inline_key', 'hermes_base_url'],
  anthropic: ['hermes_anthropic_key'],
  gemini: ['hermes_gemini_key'],
  deepseek: ['hermes_deepseek_key'],
  xai: ['hermes_xai_key'],
  zai: ['hermes_zai_key'],
  minimax: ['hermes_minimax_key'],
  'minimax-cn': ['hermes_minimax_cn_key'],
  'kimi-coding': ['hermes_kimi_key'],
  'kimi-coding-cn': ['hermes_kimi_cn_key'],
  nvidia: ['hermes_nvidia_key'],
  alibaba: ['hermes_alibaba_key'],
  'alibaba-coding-plan': ['hermes_alibaba_coding_plan_key'],
  copilot: ['hermes_copilot_key'],
  lmstudio: ['hermes_lmstudio_key', 'hermes_lmstudio_base_url'],
  'azure-foundry': [
    'hermes_azure_foundry_key',
    'hermes_azure_foundry_base_url',
  ],
  stepfun: ['hermes_stepfun_key'],
  arcee: ['hermes_arcee_key'],
  gmi: ['hermes_gmi_key'],
  huggingface: ['hermes_huggingface_key'],
  kilocode: ['hermes_kilocode_key'],
  'opencode-zen': ['hermes_opencode_zen_key'],
  'opencode-go': ['hermes_opencode_go_key'],
  xiaomi: ['hermes_xiaomi_key'],
  'tencent-tokenhub': ['hermes_tencent_tokenhub_key'],
  'ollama-cloud': ['hermes_ollama_cloud_key'],
  novita: ['hermes_novita_key'],
};

const HERMES_DYNAMIC_FIELDS = new Set([
  'hermes_inline_key',
  'hermes_base_url',
  ...Object.values(HERMES_PROVIDER_FIELDS).flat(),
]);

const CODEX_GRANULAR_APPROVAL_FIELDS = [
  'codex_approval_sandbox',
  'codex_approval_rules',
  'codex_approval_skills',
  'codex_approval_permissions',
  'codex_approval_mcp',
];

const PI_STRUCTURED_CONFIGURATION_FIELDS = new Set([
  'pi_anthropic_api_key',
  'pi_openai_api_key',
  'pi_google_api_key',
  'pi_opencode_api_key',
  'pi_default_provider',
  'pi_default_model',
  'pi_thinking_level',
]);

function filterVisibleFields(
  config: AgentNativeConfigView | null,
  drafts: Record<string, string>
): AgentNativeConfigFieldView[] {
  const fields = config?.fields ?? [];
  if (fields.some((field) => field.id === 'codex_approval_policy')) {
    const granular = drafts.codex_approval_policy === 'granular';
    return fields.filter(
      (field) =>
        !CODEX_GRANULAR_APPROVAL_FIELDS.includes(field.id) ||
        granular ||
        field.present
    );
  }
  if (config?.settings_features.includes('pi_configuration')) {
    return fields.filter(
      (field) => !PI_STRUCTURED_CONFIGURATION_FIELDS.has(field.id)
    );
  }
  if (!fields.some((field) => field.id === 'hermes_provider')) return fields;
  const selected = drafts.hermes_provider ?? '';
  const selectedFields = new Set(HERMES_PROVIDER_FIELDS[selected] ?? []);
  return fields.filter(
    (field) =>
      !HERMES_DYNAMIC_FIELDS.has(field.id) ||
      selectedFields.has(field.id) ||
      field.present
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function parentDirectory(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator > 0 ? path.slice(0, separator) : path;
}
