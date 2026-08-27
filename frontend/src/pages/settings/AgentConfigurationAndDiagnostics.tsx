import { ChevronDown, FolderOpen, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentModelCatalogView,
  AgentNativeConfigFieldView,
  AgentNativeConfigFileView,
  AgentNativeConfigFileWriteRequest,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigSurface,
  AgentNativeConfigView,
} from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';
import { desktopApi } from '@/lib/api';

import {
  AgentConfigFieldsCard,
  layoutConfigFields,
} from './CodexQuickSettings';
import { AgentSectionHeading } from './SettingsSection';
import { PiConfigurationPanel } from './PiConfigurationPanel';
import { PiProviderBuilder } from './PiProviderBuilder';
import { SettingsActionBar } from './SettingsUi';
import { containsCjk, humanizeIdentifier } from './agentConfigLabels';

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
  embedded?: boolean;
  locked?: boolean;
  fieldSurface?: AgentNativeConfigSurface;
};

export function configFilePathsForSurface(
  config: AgentNativeConfigView | null,
  fieldSurface?: AgentNativeConfigSurface
): string[] {
  const paths: string[] = [];
  for (const field of fieldsForSurface(config, fieldSurface)) {
    if (field.path && !paths.includes(field.path)) paths.push(field.path);
  }
  return paths;
}

export function AgentConfigPathMeta({
  paths,
  saving,
}: {
  paths: string[];
  saving: boolean;
}) {
  const { t } = useTranslation('settings');
  if (paths.length === 0) return null;
  return (
    <div className="agent-config-path-meta">
      {paths.map((path) => (
        <div className="agent-config-path-item" key={path}>
          <span title={path}>{fileName(path)}</span>
          <Button
            size="sm"
            variant="ghost"
            className="agent-config-open-folder h-7 w-7 p-0"
            aria-label={t('agents.openConfigFolderAria', {
              file: fileName(path),
            })}
            disabled={saving}
            onClick={() => {
              void desktopApi
                .revealInFileManager(parentDirectory(path))
                .catch(() => toast.error(t('agents.openConfigFolderFailed')));
            }}
          >
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

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
  embedded = false,
  locked = false,
  fieldSurface,
}: Props) {
  const { t } = useTranslation('settings');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [rawDirty, setRawDirty] = useState<Record<string, boolean>>({});
  const [childDirty, setChildDirty] = useState<Record<string, boolean>>({});
  const [configExpanded, setConfigExpanded] = useState(true);

  useEffect(() => {
    setDrafts(draftsFromConfig(config));
    setDirty({});
    setRawDirty({});
    setChildDirty({});
  }, [config]);

  const surfaceFields = useMemo(
    () => fieldsForSurface(config, fieldSurface),
    [config, fieldSurface]
  );
  const visibleFields = useMemo(
    () =>
      filterVisibleFields(
        config ? { ...config, fields: surfaceFields } : null,
        drafts
      ),
    [config, drafts, surfaceFields]
  );
  const groups = useMemo(
    () =>
      groupFieldsByPath(
        config,
        visibleFields,
        fieldSurface !== 'authentication' && fieldSurface !== 'configuration'
      ),
    [config, fieldSurface, visibleFields]
  );
  const showRuntimeSurfaces = fieldSurface !== 'authentication';
  const showFileEditor = fieldSurface !== 'authentication';
  const fieldsDisabled = saving || locked;
  const changedFields =
    config?.fields.filter(
      (field) =>
        dirty[field.id] &&
        (!fieldSurface || fieldSurfaceOf(field) === fieldSurface)
    ) ?? [];
  const canSave = changedFields.some(
    (field) => !field.secret || (drafts[field.id] ?? '').length > 0
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
  const updatePiConfigurationDirty = useCallback(
    (isDirty: boolean) => updateChildDirty('pi-configuration', isDirty),
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
  };

  const discard = () => {
    setDrafts(draftsFromConfig(config));
    setDirty({});
  };

  const save = () => {
    if (!config) return;
    const fields = changedFields.filter(
      (field) => !field.secret || (drafts[field.id] ?? '').length > 0
    );
    if (fields.length === 0) return;
    onSave({
      agent_id: config.agent_id,
      base_field_revisions: Object.fromEntries(
        fields.map((field) => [field.id, field.revision])
      ),
      fields: Object.fromEntries(
        fields.map((field) => {
          const value = drafts[field.id] ?? '';
          return [field.id, value.length > 0 ? value : null];
        })
      ),
    });
  };

  const headingPaths = groups.map(([path]) => path);
  const actionBar = config?.available ? (
    <SettingsActionBar
      dirty={changedFields.length > 0}
      saving={saving}
      disabled={!canSave}
      onDiscard={discard}
      onSave={save}
    />
  ) : null;

  return (
    <>
      <section
        aria-labelledby={embedded ? undefined : 'agent-config-heading'}
        aria-label={embedded ? t('agents.configTitle') : undefined}
        className={
          embedded
            ? 'agent-config-surface is-embedded'
            : 'settings-surface agent-config-surface'
        }
      >
        {embedded ? null : (
          <AgentSectionHeading
            headingId="agent-config-heading"
            title={t('agents.configTitle')}
            expanded={configExpanded}
            onToggle={() => setConfigExpanded((current) => !current)}
            summary={t('agents.configFieldCount', {
              count: visibleFields.length,
            })}
          >
            <AgentConfigPathMeta paths={headingPaths} saving={saving} />
          </AgentSectionHeading>
        )}

        {embedded || configExpanded ? (
          <>
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
                {showRuntimeSurfaces &&
                config.settings_features.includes('pi_configuration') ? (
                  <PiConfigurationPanel
                    disabled={fieldsDisabled}
                    onDirtyChange={updatePiConfigurationDirty}
                  />
                ) : null}
                {fieldSurface === 'authentication' ? (
                  <div className="agent-config-groups">
                    {groups.map(([path, fields]) => (
                      <fieldset
                        className="agent-config-group"
                        key={path}
                        aria-label={fileName(path)}
                      >
                        {fields.length > 0 ? (
                          <div className="agent-config-grid">
                            {layoutConfigFields(fields).map(({ field }) => (
                              <ConfigField
                                key={field.id}
                                drafts={drafts}
                                field={field}
                                value={drafts[field.id] ?? ''}
                                saving={fieldsDisabled}
                                onChange={(value) =>
                                  updateDraft(field.id, value)
                                }
                              />
                            ))}
                          </div>
                        ) : null}
                      </fieldset>
                    ))}
                  </div>
                ) : (
                  <>
                    {visibleFields.length > 0 ? (
                      <details className="agent-config-block" open>
                        <summary>
                          <span className="agent-config-block-heading">
                            <strong>{t('agents.configFields')}</strong>
                          </span>
                          <ChevronDown
                            aria-hidden="true"
                            className="agent-config-file-chevron"
                          />
                        </summary>
                        <AgentConfigFieldsCard
                          fields={visibleFields}
                          drafts={drafts}
                          disabled={fieldsDisabled}
                          onChange={updateDraft}
                        />
                      </details>
                    ) : null}
                    {showFileEditor
                      ? groups.map(([path, , file]) => (
                          <ConfigFileEditor
                            key={path}
                            agentId={config.agent_id}
                            file={file}
                            saving={fieldsDisabled}
                            onSave={onSaveFile}
                            onDirtyChange={updateRawDirty}
                          />
                        ))
                      : null}
                  </>
                )}
              </>
            )}
            {embedded ? actionBar : null}
          </>
        ) : null}
      </section>
      {embedded ? null : actionBar}
    </>
  );
}

function ConfigField({
  field,
  value,
  drafts,
  saving,
  onChange,
}: {
  field: AgentNativeConfigFieldView;
  value: string;
  drafts?: Record<string, string>;
  saving: boolean;
  onChange: (value: string) => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const inputId = `agent-config-${field.id}`;
  const labelId = `${inputId}-label`;
  const english = i18n.resolvedLanguage?.startsWith('en') ?? false;
  const label = english ? humanizeIdentifier(field.id) : field.label;
  const wide =
    field.kind === 'json' ||
    field.id === 'pi_custom_providers' ||
    field.id === 'grok_custom_model_id';
  const placeholder =
    field.secret && field.present
      ? t('agents.replaceSecretPlaceholder')
      : field.value || t('agents.notSet');
  return (
    <div className={`agent-config-field${wide ? ' is-wide' : ''}`}>
      <div className="agent-config-field-label">
        {field.id === 'pi_custom_providers' ? (
          <span id={labelId}>{label}</span>
        ) : (
          <label htmlFor={inputId}>{label}</label>
        )}
      </div>
      <div className="agent-config-field-control">
        {field.id === 'pi_custom_providers' ? (
          <div id={inputId} aria-labelledby={labelId} role="group">
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
          <AstryxSelect
            id={inputId}
            ariaLabel={label}
            disabled={saving}
            hasClear
            placeholder={placeholder}
            value={value}
            options={field.options.map((option) => ({
              value: option.value,
              label:
                english && containsCjk(option.label)
                  ? humanizeIdentifier(option.value)
                  : option.label,
            }))}
            onChange={onChange}
          />
        ) : field.kind === 'boolean' ? (
          <label className="agent-config-boolean" htmlFor={inputId}>
            <input
              id={inputId}
              aria-label={label}
              checked={
                field.id === 'codex_responses_websockets'
                  ? value === 'false'
                  : value === 'true'
              }
              disabled={saving}
              name={`agent_config_${field.id}`}
              type="checkbox"
              onChange={(event) =>
                onChange(
                  String(
                    field.id === 'codex_responses_websockets'
                      ? !event.target.checked
                      : event.target.checked
                  )
                )
              }
            />
            <span>
              {(
                field.id === 'codex_responses_websockets'
                  ? value === 'false'
                  : value === 'true'
              )
                ? t('agents.on')
                : t('agents.off')}
            </span>
          </label>
        ) : field.id === 'grok_custom_model_id' ? (
          <GrokOfficialModelField
            disabled={saving}
            drafts={drafts ?? {}}
            label={label}
            value={value}
            onChange={onChange}
          />
        ) : (
          <input
            id={inputId}
            aria-label={label}
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
            value={
              field.secret && field.present && value === ''
                ? (field.masked_value ?? '••••••••')
                : value
            }
            placeholder={placeholder}
            onFocus={
              field.secret && field.present
                ? (event) => event.currentTarget.select()
                : undefined
            }
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </div>
    </div>
  );
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
  const name = file ? fileName(file.path) : t('agents.configFile');
  const sensitive = file?.sensitive === true && file.exists;
  const content = file?.content ?? '';
  const editorLabel = file
    ? t('agents.editConfigFileAria', { file: name })
    : t('agents.configFile');

  return (
    <details
      aria-label={
        sensitive
          ? t('agents.sensitivePreviewAria', { file: name })
          : t('agents.configFileAria', { file: name })
      }
      className={`agent-config-block agent-config-file${sensitive ? ' is-sensitive' : ''}`}
    >
      <summary>
        <span className="agent-config-block-heading">
          <strong>{t('agents.configFile')}</strong>
        </span>
        <span className="agent-config-file-end">
          <span className="agent-config-file-format">
            {file?.format.toUpperCase() ?? 'FILE'}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="agent-config-file-chevron"
          />
        </span>
      </summary>
      {file && !file.sensitive ? (
        <>
          <div className="agent-config-file-body">
            <label className="sr-only" htmlFor={`agent-file-${file.path}`}>
              {editorLabel}
            </label>
            <textarea
              id={`agent-file-${file.path}`}
              aria-label={editorLabel}
              disabled={saving}
              placeholder={file.exists ? undefined : t('agents.fileNotCreated')}
              rows={16}
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
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
        </>
      ) : (
        <pre
          className="agent-config-file-body"
          tabIndex={sensitive ? 0 : undefined}
        >
          {file?.exists ? content : t('agents.fileNotCreated')}
        </pre>
      )}
    </details>
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
  fields: AgentNativeConfigFieldView[],
  includeFilesWithoutFields: boolean
): [
  string,
  AgentNativeConfigFieldView[],
  AgentNativeConfigFileView | undefined,
][] {
  const groups = new Map<string, AgentNativeConfigFieldView[]>(
    includeFilesWithoutFields
      ? (config?.files ?? []).map((file) => [file.path, []])
      : []
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

function fieldSurfaceOf(
  field: AgentNativeConfigFieldView
): AgentNativeConfigSurface {
  return field.surface ?? 'configuration';
}

function fieldsForSurface(
  config: AgentNativeConfigView | null,
  fieldSurface?: AgentNativeConfigSurface
): AgentNativeConfigFieldView[] {
  const fields = config?.fields ?? [];
  if (!fieldSurface) return fields;
  return fields.filter((field) => fieldSurfaceOf(field) === fieldSurface);
}

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

const CLAUDE_OFFICIAL_API_FIELDS = new Set([
  'anthropic_api_key',
  'haiku_model',
  'sonnet_model',
  'opus_model',
]);

export function configForAuthMode(
  agentId: string,
  mode: string,
  config: AgentNativeConfigView
): AgentNativeConfigView {
  const allowed = authenticationFieldIdsForMode(agentId, mode);
  if (!allowed) return config;
  return {
    ...config,
    fields: config.fields.filter((field) => allowed.has(field.id)),
  };
}

function authenticationFieldIdsForMode(
  agentId: string,
  mode: string
): Set<string> | null {
  if (
    agentId === 'claude_code' &&
    (mode === 'official_api' || mode === 'custom')
  ) {
    return CLAUDE_OFFICIAL_API_FIELDS;
  }
  if (agentId === 'codex' && mode === 'api_key') {
    return new Set(['openai_api_key']);
  }
  if (agentId === 'grok' && mode === 'api_key') {
    return new Set([
      'grok_api_key',
      'grok_custom_model_id',
      'grok_api_backend',
      'grok_context_window',
    ]);
  }
  if (
    (agentId === 'grok' && (mode === 'custom' || mode === 'model_provider')) ||
    (agentId === 'kimi_code' &&
      (mode === 'official_api' || mode === 'model_provider'))
  ) {
    return new Set();
  }
  if (agentId === 'antigravity' || agentId === 'gemini') {
    if (mode === 'gemini-api-key') return new Set(['antigravity_api_key']);
    if (mode === 'agent-platform') {
      return new Set([
        'antigravity_google_api_key',
        'antigravity_cloud_project',
        'antigravity_cloud_location',
      ]);
    }
  }
  return null;
}

function GrokOfficialModelField({
  label,
  value,
  drafts,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  drafts: Record<string, string>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const [catalog, setCatalog] = useState<AgentModelCatalogView | null>(null);
  const [detecting, setDetecting] = useState(false);
  const detect = async () => {
    const apiKey = drafts.grok_api_key?.trim();
    if (!apiKey) {
      toast.warning(t('agents.providerRequiredFields'));
      return;
    }
    setDetecting(true);
    try {
      const next = await agentManagementApi.modelProviderCatalog(
        'grok',
        null,
        drafts.grok_base_url?.trim() || 'https://api.x.ai/v1',
        apiKey
      );
      setCatalog(next);
      if (!value && next.default_model) onChange(next.default_model);
    } catch (cause) {
      toast.error(errorMessage(cause, t('agents.modelCatalogLoadFailed')));
    } finally {
      setDetecting(false);
    }
  };
  const options = (catalog?.models ?? []).map((model) => ({
    value: model.id,
    label: model.label || model.id,
  }));
  return (
    <div className="agent-grok-official-model">
      {options.length ? (
        <AstryxSelect
          ariaLabel={label}
          disabled={disabled}
          hasClear
          options={options}
          placeholder={t('agents.notSet')}
          value={value}
          onChange={onChange}
        />
      ) : (
        <input
          aria-label={label}
          autoComplete="off"
          disabled={disabled}
          name="agent_config_grok_custom_model_id"
          placeholder={t('agents.notSet')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <Button
        className="h-8"
        disabled={disabled || detecting}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => void detect()}
      >
        {detecting ? (
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
        ) : null}
        {t('agents.loadModels')}
      </Button>
    </div>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function parentDirectory(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator > 0 ? path.slice(0, separator) : path;
}
