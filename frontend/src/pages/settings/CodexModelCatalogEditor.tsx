import { ChevronDown, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentModelCatalogView,
  CodexCustomModelRequest,
  CodexModelCatalogConfigRequest,
  JsonValue,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

const ENUM_OVERRIDES = [
  [
    'default_reasoning_summary',
    'codexOverrideReasoningSummary',
    ['auto', 'concise', 'detailed', 'none'],
  ],
  [
    'default_verbosity',
    'codexOverrideDefaultVerbosity',
    ['low', 'medium', 'high', '__null__'],
  ],
  [
    'shell_type',
    'codexOverrideShellType',
    ['default', 'local', 'unified_exec', 'disabled', 'shell_command'],
  ],
  [
    'apply_patch_tool_type',
    'codexOverrideApplyPatchType',
    ['freeform', '__null__'],
  ],
] as const;

const BOOLEAN_OVERRIDES = [
  ['supports_reasoning_summaries', 'codexOverrideSupportsReasoningSummaries'],
  ['support_verbosity', 'codexOverrideSupportsVerbosity'],
  ['supports_parallel_tool_calls', 'codexOverrideSupportsParallelTools'],
  ['supports_search_tool', 'codexOverrideSupportsSearch'],
] as const;

export function CodexModelCatalogEditor({
  disabled,
  onDirtyChange,
}: {
  disabled: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const [catalog, setCatalog] = useState<AgentModelCatalogView | null>(null);
  const [draft, setDraft] = useState<CodexModelCatalogConfigRequest | null>(
    null
  );
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [originalDraft, setOriginalDraft] =
    useState<CodexModelCatalogConfigRequest | null>(null);
  const dirty = Boolean(
    draft &&
      originalDraft &&
      JSON.stringify(draft) !== JSON.stringify(originalDraft)
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const load = async () => {
    if (loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const [catalogResult, config] = await Promise.all([
        agentManagementApi.codexModelCatalog(false),
        agentManagementApi.codexModelCatalogConfig(),
      ]);
      setCatalog(catalogResult);
      const nextDraft = {
        customs: config.customs,
        excluded_officials: config.excluded_officials,
        default_model: config.default_model,
      };
      setDraft(nextDraft);
      setOriginalDraft(nextDraft);
      setSavedPath(config.active ? config.catalog_path : null);
      setLoaded(true);
      if (!catalogResult.models.length) {
        setError(catalogResult.error ?? t('agents.codexCatalogRuntimeEmpty'));
      }
    } catch (cause) {
      setError(errorMessage(cause, t('agents.codexCatalogActionFailed')));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await agentManagementApi.applyCodexModelCatalog(draft);
      const nextDraft = {
        customs: result.customs,
        excluded_officials: result.excluded_officials,
        default_model: result.default_model,
      };
      setDraft(nextDraft);
      setOriginalDraft(nextDraft);
      setSavedPath(result.active ? result.catalog_path : null);
    } catch (cause) {
      setError(errorMessage(cause, t('agents.codexCatalogActionFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details
      className="codex-model-editor"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>
        <span>
          <strong>{t('agents.codexCatalogAdvanced')}</strong>
          <small>{t('agents.codexCatalogAdvancedDescription')}</small>
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </summary>
      {loading ? (
        <p className="codex-model-editor-state" aria-live="polite">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t('agents.codexCatalogLoading')}
        </p>
      ) : draft && catalog?.models.length ? (
        <div className="codex-model-editor-body">
          <fieldset>
            <legend>{t('agents.codexOfficialModels')}</legend>
            <div className="codex-official-models">
              {catalog.models.map((model) => {
                const included = !draft.excluded_officials.includes(model.id);
                return (
                  <label key={model.id}>
                    <input
                      type="checkbox"
                      checked={included}
                      disabled={disabled || saving}
                      name={`codex_official_${model.id}`}
                      onChange={(event) => {
                        const excluded = event.target.checked
                          ? draft.excluded_officials.filter(
                              (slug) => slug !== model.id
                            )
                          : [...draft.excluded_officials, model.id];
                        setDraft({ ...draft, excluded_officials: excluded });
                      }}
                    />
                    <span>
                      <strong>{model.label}</strong>
                      <code>{model.id}</code>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <div className="codex-custom-model-heading">
              <legend>{t('agents.codexCustomModels')}</legend>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={disabled || saving}
                onClick={() => {
                  const base = catalog.models[0]?.id;
                  if (!base) return;
                  setDraft({
                    ...draft,
                    customs: [
                      ...draft.customs,
                      {
                        slug: `custom-model-${draft.customs.length + 1}`,
                        display_name: null,
                        context_window: null,
                        base,
                        overrides: null,
                      },
                    ],
                  });
                }}
              >
                <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                {t('agents.add')}
              </Button>
            </div>
            {draft.customs.length ? (
              <ul className="codex-custom-models">
                {draft.customs.map((custom, index) => (
                  <CustomModelRow
                    key={`custom-${index}`}
                    custom={custom}
                    bases={catalog.models}
                    disabled={disabled || saving}
                    rowLabel={t('agents.codexCustomModelNumber', {
                      number: index + 1,
                    })}
                    onChange={(next) => {
                      const customs = [...draft.customs];
                      customs[index] = next;
                      setDraft({ ...draft, customs });
                    }}
                    onRemove={() =>
                      setDraft({
                        ...draft,
                        customs: draft.customs.filter(
                          (_, customIndex) => customIndex !== index
                        ),
                      })
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="codex-model-editor-empty">
                {t('agents.codexCustomModelsEmptyOfficial')}
              </p>
            )}
          </fieldset>

          <label className="codex-default-model">
            <span>{t('agents.defaultModelLabel')}</span>
            <select
              aria-label={t('agents.codexDefaultModelAria')}
              autoComplete="off"
              disabled={disabled || saving}
              name="codex_catalog_default_model"
              value={draft.default_model ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  default_model: event.target.value || null,
                })
              }
            >
              <option value="">{t('agents.codexDecides')}</option>
              {draft.customs.map((custom) => (
                <option key={custom.slug} value={custom.slug}>
                  {custom.display_name || custom.slug} · {t('agents.custom')}
                </option>
              ))}
              {catalog.models
                .filter((model) => !draft.excluded_officials.includes(model.id))
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
            </select>
          </label>

          <div className="codex-model-editor-footer">
            <p aria-live="polite">
              {savedPath
                ? t('agents.codexCatalogEnabled', { path: savedPath })
                : t('agents.codexCatalogNative')}
            </p>
            <Button
              size="sm"
              className="h-8"
              disabled={disabled || saving}
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <Save aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('agents.codexCatalogSave')}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="codex-model-editor-error" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  );
}

export function CodexModelConfigFields({
  catalog,
  draft,
  disabled,
  onChange,
}: {
  catalog: AgentModelCatalogView;
  draft: CodexModelCatalogConfigRequest;
  disabled: boolean;
  onChange: (next: CodexModelCatalogConfigRequest) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <>
      <fieldset>
        <legend>{t('agents.codexOfficialModels')}</legend>
        <div className="codex-official-models">
          {catalog.models.map((model) => {
            const included = !draft.excluded_officials.includes(model.id);
            return (
              <label key={model.id}>
                <input
                  type="checkbox"
                  checked={included}
                  disabled={disabled}
                  name={`codex_official_${model.id}`}
                  onChange={(event) => {
                    const excluded = event.target.checked
                      ? draft.excluded_officials.filter(
                          (slug) => slug !== model.id
                        )
                      : [...draft.excluded_officials, model.id];
                    onChange({ ...draft, excluded_officials: excluded });
                  }}
                />
                <span>
                  <strong>{model.label}</strong>
                  <code>{model.id}</code>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <div className="codex-custom-model-heading">
          <legend>{t('agents.codexCustomModels')}</legend>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={disabled}
            onClick={() => {
              const base = catalog.models[0]?.id;
              if (!base) return;
              onChange({
                ...draft,
                customs: [
                  ...draft.customs,
                  {
                    slug: `custom-model-${draft.customs.length + 1}`,
                    display_name: null,
                    context_window: null,
                    base,
                    overrides: null,
                  },
                ],
              });
            }}
          >
            <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            {t('agents.add')}
          </Button>
        </div>
        {draft.customs.length ? (
          <ul className="codex-custom-models">
            {draft.customs.map((custom, index) => (
              <CustomModelRow
                key={`${custom.slug}-${index}`}
                custom={custom}
                bases={catalog.models}
                disabled={disabled}
                rowLabel={t('agents.codexCustomModelNumber', {
                  number: index + 1,
                })}
                onChange={(next) => {
                  const customs = [...draft.customs];
                  customs[index] = next;
                  onChange({ ...draft, customs });
                }}
                onRemove={() =>
                  onChange({
                    ...draft,
                    customs: draft.customs.filter(
                      (_, customIndex) => customIndex !== index
                    ),
                  })
                }
              />
            ))}
          </ul>
        ) : (
          <p className="codex-model-editor-empty">
            {t('agents.codexCustomModelsEmpty')}
          </p>
        )}
      </fieldset>

      <label className="codex-default-model">
        <span>{t('agents.defaultModelLabel')}</span>
        <select
          aria-label={t('agents.codexDefaultModelAria')}
          autoComplete="off"
          disabled={disabled}
          name="codex_catalog_default_model"
          value={draft.default_model ?? ''}
          onChange={(event) =>
            onChange({
              ...draft,
              default_model: event.target.value || null,
            })
          }
        >
          <option value="">{t('agents.codexDecides')}</option>
          {draft.customs.map((custom) => (
            <option key={custom.slug} value={custom.slug}>
              {custom.display_name || custom.slug} · {t('agents.custom')}
            </option>
          ))}
          {catalog.models
            .filter((model) => !draft.excluded_officials.includes(model.id))
            .map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
        </select>
      </label>
    </>
  );
}

function CustomModelRow({
  custom,
  bases,
  disabled,
  rowLabel,
  onChange,
  onRemove,
}: {
  custom: CodexCustomModelRequest;
  bases: AgentModelCatalogView['models'];
  disabled: boolean;
  rowLabel: string;
  onChange: (next: CodexCustomModelRequest) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const overrides = jsonObject(custom.overrides);
  const base = bases.find((candidate) => candidate.id === custom.base);
  const setOverride = (key: string, value: JsonValue | undefined) => {
    const next = { ...overrides };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange({
      ...custom,
      overrides: Object.keys(next).length ? next : null,
    });
  };

  return (
    <li>
      <label>
        <span>{t('agents.modelId')}</span>
        <input
          aria-label={t('agents.codexCustomFieldAria', {
            row: rowLabel,
            field: t('agents.modelId'),
          })}
          autoComplete="off"
          disabled={disabled}
          name={`${rowLabel.replaceAll(' ', '_')}_id`}
          spellCheck={false}
          value={custom.slug}
          onChange={(event) =>
            onChange({ ...custom, slug: event.target.value })
          }
        />
      </label>
      <label>
        <span>{t('agents.displayName')}</span>
        <input
          aria-label={t('agents.codexCustomFieldAria', {
            row: rowLabel,
            field: t('agents.displayName'),
          })}
          autoComplete="off"
          disabled={disabled}
          name={`${rowLabel.replaceAll(' ', '_')}_name`}
          value={custom.display_name ?? ''}
          onChange={(event) =>
            onChange({ ...custom, display_name: event.target.value || null })
          }
        />
      </label>
      <label>
        <span>{t('agents.capabilityTemplate')}</span>
        <select
          aria-label={t('agents.codexCustomFieldAria', {
            row: rowLabel,
            field: t('agents.capabilityTemplate'),
          })}
          autoComplete="off"
          disabled={disabled}
          name={`${rowLabel.replaceAll(' ', '_')}_base`}
          value={custom.base}
          onChange={(event) =>
            onChange({ ...custom, base: event.target.value })
          }
        >
          {bases.map((base) => (
            <option key={base.id} value={base.id}>
              {base.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t('agents.contextWindow')}</span>
        <input
          aria-label={t('agents.codexCustomFieldAria', {
            row: rowLabel,
            field: t('agents.contextWindow'),
          })}
          autoComplete="off"
          disabled={disabled}
          inputMode="numeric"
          min={1}
          name={`${rowLabel.replaceAll(' ', '_')}_context`}
          type="number"
          value={custom.context_window?.toString() ?? ''}
          onChange={(event) =>
            onChange({
              ...custom,
              context_window: event.target.value
                ? Number.parseInt(event.target.value, 10)
                : null,
            })
          }
        />
      </label>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-8 self-end p-0"
        aria-label={t('agents.codexDeleteCustomAria', { row: rowLabel })}
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
      </Button>
      <details className="codex-custom-advanced">
        <summary>{t('agents.codexAdvancedOverrides')}</summary>
        <div className="codex-custom-advanced-grid">
          {base?.reasoning_levels.length ? (
            <OverrideSelect
              ariaLabel={t('agents.codexCustomFieldAria', {
                row: rowLabel,
                field: t('agents.defaultReasoningEffort'),
              })}
              label={t('agents.defaultReasoningEffort')}
              name={`${rowLabel}_reasoning_level`}
              disabled={disabled}
              options={base.reasoning_levels}
              value={overrides.default_reasoning_level}
              onChange={(value) =>
                setOverride('default_reasoning_level', value)
              }
            />
          ) : null}
          {ENUM_OVERRIDES.map(([key, labelKey, options]) => (
            <OverrideSelect
              key={key}
              ariaLabel={t('agents.codexCustomFieldAria', {
                row: rowLabel,
                field: t(`agents.${labelKey}`),
              })}
              label={t(`agents.${labelKey}`)}
              name={`${rowLabel}_${key}`}
              disabled={disabled}
              nullable={options.some((option: string) => option === '__null__')}
              options={options.filter((option) => option !== '__null__')}
              value={overrides[key]}
              onChange={(value) => setOverride(key, value)}
            />
          ))}
          {BOOLEAN_OVERRIDES.map(([key, labelKey]) => (
            <OverrideSelect
              key={key}
              ariaLabel={t('agents.codexCustomFieldAria', {
                row: rowLabel,
                field: t(`agents.${labelKey}`),
              })}
              label={t(`agents.${labelKey}`)}
              name={`${rowLabel}_${key}`}
              disabled={disabled}
              options={['true', 'false']}
              value={
                typeof overrides[key] === 'boolean'
                  ? String(overrides[key])
                  : undefined
              }
              onChange={(value) =>
                setOverride(
                  key,
                  value === undefined ? undefined : value === 'true'
                )
              }
            />
          ))}
          <OverrideText
            ariaLabel={t('agents.codexCustomFieldAria', {
              row: rowLabel,
              field: t('agents.modelDescription'),
            })}
            label={t('agents.modelDescription')}
            name={`${rowLabel}_description`}
            disabled={disabled}
            value={overrides.description}
            onChange={(value) => setOverride('description', value)}
          />
          <OverrideText
            ariaLabel={t('agents.codexCustomFieldAria', {
              row: rowLabel,
              field: t('agents.baseInstructions'),
            })}
            label={t('agents.baseInstructions')}
            name={`${rowLabel}_base_instructions`}
            disabled={disabled}
            multiline
            value={overrides.base_instructions}
            onChange={(value) => setOverride('base_instructions', value)}
          />
        </div>
      </details>
    </li>
  );
}

function OverrideSelect({
  ariaLabel,
  label,
  name,
  disabled,
  nullable = false,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  label: string;
  name: string;
  disabled: boolean;
  nullable?: boolean;
  options: readonly string[];
  value: unknown;
  onChange: (value: string | null | undefined) => void;
}) {
  const { t } = useTranslation('settings');
  const selected = value === null ? '__null__' : String(value ?? '');
  return (
    <label>
      <span>{label}</span>
      <select
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        name={name.replaceAll(' ', '_')}
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === '' ? undefined : next === '__null__' ? null : next);
        }}
      >
        <option value="">{t('agents.inheritCapabilityTemplate')}</option>
        {nullable ? <option value="__null__">{t('agents.none')}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function OverrideText({
  ariaLabel,
  label,
  name,
  disabled,
  multiline = false,
  value,
  onChange,
}: {
  ariaLabel: string;
  label: string;
  name: string;
  disabled: boolean;
  multiline?: boolean;
  value: unknown;
  onChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation('settings');
  const current = typeof value === 'string' ? value : '';
  return (
    <label className={multiline ? 'codex-custom-advanced-wide' : undefined}>
      <span>
        {label}
        {typeof value === 'string' ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(undefined)}
          >
            {t('agents.restoreInherited')}
          </button>
        ) : null}
      </span>
      {multiline ? (
        <textarea
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          name={name.replaceAll(' ', '_')}
          rows={5}
          spellCheck={false}
          value={current}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <textarea
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          name={name.replaceAll(' ', '_')}
          rows={2}
          value={current}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function jsonObject(
  value: JsonValue | null | undefined
): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}
