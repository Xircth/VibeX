import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Loader2, ScanSearch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import {
  createPluginControlApi,
  type PluginProductDetail,
} from '@/lib/api/plugins';
import { openSettingsSurface } from '@/lib/api/settingsWindow';
import { useBackendCapabilities, useBackendTransport } from '@/lib/transport';
import {
  AgentDefaultsField,
  isAgentDefaultsSchema,
} from './AgentDefaultsField';
import { officialConfigFieldCopy } from './officialPlugins';
import { pluginConfigEnableItemCount } from './pluginConfigEnableConfirm';
import { errorMessage } from './pluginQueries';

type JsonSchema = Record<string, unknown>;

interface DiscoveredModelOption {
  id: string;
  name?: string | null;
}

function schemaTitle(schema: JsonSchema, fallback: string): string {
  return typeof schema.title === 'string' && schema.title.trim()
    ? schema.title
    : fallback;
}

function formatConfigValue(value: unknown): string {
  if (value == null || value === '') return '—';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function schemaProperties(schema: JsonSchema): Array<[string, JsonSchema]> {
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return [];
  }
  return Object.entries(properties as Record<string, JsonSchema>);
}

function BooleanSchemaField({
  label,
  description,
  schema,
  value,
  disabled,
  copy,
  onChange,
}: {
  label: string;
  description?: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  copy: ReactNode;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation('settings');
  const [confirming, setConfirming] = useState(false);
  const enabled = Boolean(value);
  const enableCount = pluginConfigEnableItemCount(schema, description);

  return (
    <div className="product-plugin-config-row">
      {copy}
      <Switch
        aria-label={label}
        checked={enabled}
        disabled={disabled || confirming}
        onCheckedChange={(checked) => {
          if (!checked || enabled || enableCount == null) {
            onChange(checked);
            return;
          }
          setConfirming(true);
          void ConfirmDialog.show({
            title: label,
            message: t('plugins.configEnablePackConfirm', {
              count: enableCount,
            }),
            confirmText: t('plugins.configEnablePackConfirmAction'),
            cancelText: t('common:cancel'),
            variant: 'info',
          })
            .then((result) => {
              if (result === 'confirmed') onChange(true);
            })
            .finally(() => setConfirming(false));
        }}
      />
    </div>
  );
}

function ModelSchemaField({
  label,
  schema,
  value,
  disabled,
  copy,
  discoveredModels,
  discoveringModels,
  onDiscoverModels,
  onChange,
}: {
  label: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  copy: ReactNode;
  discoveredModels: DiscoveredModelOption[];
  discoveringModels: boolean;
  onDiscoverModels: () => void;
  onChange: (value: unknown, commit?: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const defaultModel =
    typeof schema.default === 'string' ? schema.default.trim() : '';
  const currentValue =
    typeof value === 'string' && value.trim()
      ? value.trim()
      : defaultModel;

  const options = useMemo(() => {
    const merged: DiscoveredModelOption[] = [];
    const seen = new Set<string>();
    for (const entry of discoveredModels) {
      const id = entry.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push({ id, name: entry.name });
    }
    if (currentValue && !seen.has(currentValue)) {
      merged.unshift({ id: currentValue, name: null });
    }
    return merged;
  }, [currentValue, discoveredModels]);

  return (
    <div className="product-plugin-config-row">
      {copy}
      <div className="flex items-center gap-2">
        <Select
          value={currentValue}
          disabled={disabled || options.length === 0}
          onValueChange={(next) => onChange(next, true)}
        >
          <SelectTrigger
            className="product-plugin-config-control min-w-[180px]"
            aria-label={label}
          >
            <SelectValue
              placeholder={t('plugins.selectModelPlaceholder', {
                defaultValue: '请先拉取模型',
              })}
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name && item.name.trim() && item.name.trim() !== item.id
                  ? `${item.name.trim()} (${item.id})`
                  : item.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0"
          aria-busy={discoveringModels}
          disabled={disabled || discoveringModels}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onDiscoverModels}
        >
          {discoveringModels ? (
            <Loader2
              aria-hidden="true"
              className="mr-1.5 h-3.5 w-3.5 animate-spin"
            />
          ) : (
            <ScanSearch aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('plugins.fetchModels', { defaultValue: '拉取模型' })}
        </Button>
      </div>
    </div>
  );
}

export const CODE_COMPLETION_SHORTCUT_STORAGE_KEY =
  'vibex:code-completion:manualShortcut';

export function formatShortcutFromKeyboardEvent(
  event: KeyboardEvent
): string | null {
  const modifierOnlyKeys = new Set([
    'Control',
    'Shift',
    'Alt',
    'Meta',
    'OS',
    'CapsLock',
  ]);
  if (modifierOnlyKeys.has(event.key)) {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  const codeMap: Record<string, string> = {
    Backslash: '\\',
    Slash: '/',
    Period: '.',
    Comma: ',',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Space: 'Space',
  };

  let keyToken = '';
  if (event.code && /^Key([A-Z])$/.test(event.code)) {
    keyToken = event.code.slice(3).toUpperCase();
  } else if (event.code && /^Digit([0-9])$/.test(event.code)) {
    keyToken = event.code.slice(5);
  } else if (event.code && codeMap[event.code]) {
    keyToken = codeMap[event.code]!;
  } else if (event.key === ' ' || event.key === 'Spacebar') {
    keyToken = 'Space';
  } else if (event.key.length === 1) {
    keyToken = event.key.toUpperCase();
  } else {
    keyToken = event.key;
  }

  if (!keyToken) return null;
  parts.push(keyToken);
  return parts.join('+');
}

function ShortcutSchemaField({
  label,
  schema,
  value,
  disabled,
  copy,
  onChange,
  onCommit,
}: {
  label: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  copy: ReactNode;
  onChange: (value: unknown, commit?: boolean) => void;
  onCommit?: () => void;
}) {
  const { t } = useTranslation('settings');
  const [recording, setRecording] = useState(false);
  const fallback =
    typeof schema.default === 'string' ? schema.default : 'Alt+\\';
  const stringValue =
    value == null || String(value) === '' ? fallback : String(value);

  useEffect(() => {
    if (!recording) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (
        event.key === 'Escape' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        setRecording(false);
        return;
      }
      const formatted = formatShortcutFromKeyboardEvent(event);
      if (formatted) {
        setRecording(false);
        onChange(formatted, true);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [recording, onChange]);

  return (
    <div className="product-plugin-config-row">
      {copy}
      <div className="flex items-center gap-2">
        <TextInput
          label={label}
          isLabelHidden
          value={stringValue}
          isDisabled={disabled || recording}
          onChange={(next) => onChange(next, false)}
          onBlur={() => onCommit?.()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit?.();
            }
          }}
          width="100%"
          className="product-plugin-config-control [&_input]:font-mono [&_input]:text-sm"
        />
        <Button
          type="button"
          variant={recording ? 'default' : 'outline'}
          size="sm"
          className="h-9 shrink-0"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setRecording((prev) => !prev)}
        >
          <Keyboard aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {recording
            ? t('plugins.recordingShortcut', { defaultValue: '请按键...' })
            : t('plugins.recordShortcut', { defaultValue: '录制快捷键' })}
        </Button>
      </div>
    </div>
  );
}

function SchemaField({
  pluginId,
  name,
  schema,
  value,
  disabled,
  discoveredModels,
  discoveringModels,
  onDiscoverModels,
  onChange,
  onCommit,
}: {
  pluginId: string;
  name: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  discoveredModels?: DiscoveredModelOption[];
  discoveringModels?: boolean;
  onDiscoverModels?: () => void;
  onChange: (value: unknown, commit?: boolean) => void;
  onCommit?: () => void;
}) {
  const { t } = useTranslation('settings');
  const copyText = officialConfigFieldCopy(pluginId, name, schema, t);
  const label = copyText.title;
  const description = copyText.description;
  const copy = (
    <span className="product-plugin-config-copy">
      <strong>{label}</strong>
      {description ? <small>{description}</small> : null}
    </span>
  );

  if (Array.isArray(schema.enum)) {
    return (
      <div className="product-plugin-config-row">
        {copy}
        <Select
          value={String(value ?? '')}
          disabled={disabled}
          onValueChange={(next) => onChange(next, true)}
        >
          <SelectTrigger
            className="product-plugin-config-control"
            aria-label={label}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {schema.enum.map((item) => (
              <SelectItem key={String(item)} value={String(item)}>
                {copyText.enumLabel(String(item))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <BooleanSchemaField
        label={label}
        description={description}
        schema={schema}
        value={value}
        disabled={disabled}
        copy={copy}
        onChange={(next) => onChange(next, true)}
      />
    );
  }

  if (isAgentDefaultsSchema(name, schema)) {
    return (
      <AgentDefaultsField
        pluginId={pluginId}
        name={name}
        schema={schema}
        value={value}
        disabled={disabled}
        onChange={(next) => onChange(next, true)}
      />
    );
  }

  if (schema.type === 'object') {
    const draft =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return (
      <fieldset className="product-plugin-config-block">
        <legend>{copy}</legend>
        {schemaProperties(schema).map(([child, childSchema]) => (
          <SchemaField
            key={child}
            pluginId={pluginId}
            name={child}
            schema={childSchema}
            value={draft[child]}
            disabled={disabled}
            onChange={(next, commit) =>
              onChange({ ...draft, [child]: next }, commit)
            }
            onCommit={onCommit}
          />
        ))}
      </fieldset>
    );
  }

  if (schema.type === 'array') {
    const items = Array.isArray(value) ? value : [];
    const itemSchema =
      schema.items &&
      typeof schema.items === 'object' &&
      !Array.isArray(schema.items)
        ? (schema.items as JsonSchema)
        : { type: 'string' };
    return (
      <fieldset className="product-plugin-config-block">
        <legend>{copy}</legend>
        {items.map((item, index) => (
          <div key={`${name}-${index}`} className="product-plugin-config-row">
            <SchemaField
              pluginId={pluginId}
              name={`${name}-${index}`}
              schema={itemSchema}
              value={item}
              disabled={disabled}
              onChange={(next, commit) => {
                const copyItems = [...items];
                copyItems[index] = next;
                onChange(copyItems, commit);
              }}
              onCommit={onCommit}
            />
          </div>
        ))}
      </fieldset>
    );
  }

  if (
    name === 'model' &&
    schema.type === 'string' &&
    typeof onDiscoverModels === 'function'
  ) {
    return (
      <ModelSchemaField
        label={label}
        schema={schema}
        value={value}
        disabled={disabled}
        copy={copy}
        discoveredModels={discoveredModels ?? []}
        discoveringModels={Boolean(discoveringModels)}
        onDiscoverModels={onDiscoverModels}
        onChange={onChange}
      />
    );
  }

  if (
    schema.type === 'string' &&
    (name === 'manualShortcut' || name.toLowerCase().endsWith('shortcut'))
  ) {
    return (
      <ShortcutSchemaField
        label={label}
        schema={schema}
        value={value}
        disabled={disabled}
        copy={copy}
        onChange={onChange}
        onCommit={onCommit}
      />
    );
  }

  const inputType =
    schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text';
  const stringValue = value == null ? '' : String(value);
  return (
    <div className="product-plugin-config-row">
      {copy}
      {inputType === 'number' ? (
        <Input
          aria-label={label}
          type="number"
          className="product-plugin-config-control"
          disabled={disabled}
          value={stringValue}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') {
              onChange('', false);
              return;
            }
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) ? parsed : raw, false);
          }}
          onBlur={() => onCommit?.()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit?.();
            }
          }}
        />
      ) : (
        <TextInput
          label={label}
          isLabelHidden
          value={stringValue}
          isDisabled={disabled}
          onChange={(next) => onChange(next, false)}
          onBlur={() => onCommit?.()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit?.();
            }
          }}
          width="100%"
          className="product-plugin-config-control [&_input]:text-sm"
        />
      )}
    </div>
  );
}

export async function savePluginConfigResilient(
  api: ReturnType<typeof createPluginControlApi>,
  pluginId: string,
  next: Record<string, unknown>
): Promise<{
  updated: PluginProductDetail;
  effectiveConfig: Record<string, unknown>;
}> {
  if (
    pluginId === 'vibex.code-completion' &&
    typeof next.manualShortcut === 'string' &&
    next.manualShortcut.trim()
  ) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          CODE_COMPLETION_SHORTCUT_STORAGE_KEY,
          next.manualShortcut.trim()
        );
      }
    } catch {
      // ignore storage errors
    }
  }

  let updated: PluginProductDetail;
  try {
    updated = await api.saveConfig(pluginId, next);
  } catch (error) {
    if (
      pluginId === 'vibex.code-completion' &&
      'manualShortcut' in next &&
      /manualShortcut|unknown|property/i.test(errorMessage(error))
    ) {
      const { manualShortcut: _ignored, ...withoutShortcut } = next;
      updated = await api.saveConfig(pluginId, withoutShortcut);
    } else {
      throw error;
    }
  }

  const effectiveConfig: Record<string, unknown> =
    updated?.config && typeof updated.config === 'object'
      ? {
          ...updated.config,
          ...(pluginId === 'vibex.code-completion' &&
          typeof next.manualShortcut === 'string'
            ? { manualShortcut: next.manualShortcut }
            : {}),
        }
      : next;

  if (
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function'
  ) {
    window.dispatchEvent(
      new CustomEvent('vibex:plugin-config-updated', {
        detail: { pluginId, config: effectiveConfig },
      })
    );
  }

  return {
    updated: updated
      ? {
          ...updated,
          config: effectiveConfig,
        }
      : updated,
    effectiveConfig,
  };
}

function hydrateCodeCompletionConfig(
  pluginId: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  if (pluginId !== 'vibex.code-completion') return config;
  if (
    typeof config.manualShortcut === 'string' &&
    config.manualShortcut.trim()
  ) {
    return config;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(CODE_COMPLETION_SHORTCUT_STORAGE_KEY);
      if (stored && stored.trim()) {
        return { ...config, manualShortcut: stored.trim() };
      }
    }
  } catch {
    // ignore
  }
  return config;
}

export function PluginConfigForm({
  pluginId,
  detail,
  onSaved,
}: {
  pluginId: string;
  detail: PluginProductDetail;
  onSaved: (detail: PluginProductDetail) => void;
}) {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const { supports } = useBackendCapabilities();
  const initialConfig = useMemo(
    () => hydrateCodeCompletionConfig(pluginId, detail.config),
    [detail.config, pluginId]
  );
  const [draft, setDraft] = useState(initialConfig);
  const draftRef = useRef(initialConfig);
  const savedConfigRef = useRef(initialConfig);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saving, setSaving] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<
    DiscoveredModelOption[]
  >([]);
  const [discoveringModels, setDiscoveringModels] = useState(false);

  const clearCommitTimer = () => {
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  };

  useEffect(() => {
    setDiscoveredModels([]);
    return () => clearCommitTimer();
  }, [pluginId]);

  useEffect(() => {
    const hydrated = hydrateCodeCompletionConfig(pluginId, detail.config);
    if (
      commitTimerRef.current !== null ||
      JSON.stringify(hydrated) === JSON.stringify(savedConfigRef.current)
    ) {
      return;
    }
    savedConfigRef.current = hydrated;
    draftRef.current = hydrated;
    setDraft(hydrated);
  }, [detail.config, pluginId]);

  const persist = async (next: Record<string, unknown>) => {
    setSaving(true);
    try {
      savedConfigRef.current = next;
      const { updated, effectiveConfig } = await savePluginConfigResilient(
        api,
        pluginId,
        next
      );
      savedConfigRef.current = effectiveConfig;
      onSaved(updated);
    } catch (error) {
      toast.error(t('plugins.configSaveFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const commitDraft = () => {
    clearCommitTimer();
    if (
      JSON.stringify(draftRef.current) ===
      JSON.stringify(savedConfigRef.current)
    ) {
      return;
    }
    void persist(draftRef.current);
  };

  const scheduleCommitDraft = () => {
    clearCommitTimer();
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      if (
        JSON.stringify(draftRef.current) ===
        JSON.stringify(savedConfigRef.current)
      ) {
        return;
      }
      void persist(draftRef.current);
    }, 250);
  };

  const updateField = (key: string, value: unknown, commit = true) => {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
    if (commit) {
      clearCommitTimer();
      void persist(next);
    } else {
      scheduleCommitDraft();
    }
  };

  const properties = useMemo(() => {
    const base = schemaProperties(detail.configSchema);
    if (
      pluginId === 'vibex.code-completion' &&
      base.length > 0 &&
      !base.some(([key]) => key === 'manualShortcut')
    ) {
      const manualShortcutSchema: JsonSchema = {
        type: 'string',
        default: 'Alt+\\',
        description:
          'Keyboard shortcut to manually trigger inline code completion in the editor (e.g. Alt+\\, Ctrl+Shift+Space, Alt+I).',
      };
      const triggerIdx = base.findIndex(([key]) => key === 'triggerMode');
      if (triggerIdx >= 0) {
        const next = [...base];
        next.splice(triggerIdx + 1, 0, [
          'manualShortcut',
          manualShortcutSchema,
        ]);
        return next;
      }
      return [...base, ['manualShortcut', manualShortcutSchema]];
    }
    return base;
  }, [detail.configSchema, pluginId]);

  const supportsModelDiscovery = useMemo(() => {
    const keys = new Set(properties.map(([key]) => key));
    return keys.has('model') && (keys.has('baseUrl') || keys.has('apiKey'));
  }, [properties]);

  const handleDiscoverModels = async () => {
    clearCommitTimer();
    const baseUrlSchema = properties.find(([key]) => key === 'baseUrl')?.[1];
    const fallbackBaseUrl =
      typeof baseUrlSchema?.default === 'string' ? baseUrlSchema.default : '';
    const baseUrl = String(
      draftRef.current.baseUrl ?? fallbackBaseUrl ?? ''
    ).trim();
    if (!baseUrl) {
      toast.warning(t('agents.dshProviderUrlRequired'));
      return;
    }
    const apiKey = String(draftRef.current.apiKey ?? '').trim();
    setDiscoveringModels(true);
    try {
      const models = await api.discoverModels({
        baseUrl,
        apiKey: apiKey || null,
      });
      const validModels = (models ?? []).filter(
        (item) => item && typeof item.id === 'string' && item.id.trim()
      );
      setDiscoveredModels(validModels);
      const currentModel = String(draftRef.current.model ?? '').trim();
      const nextModel = validModels.some((item) => item.id === currentModel)
        ? currentModel
        : (validModels[0]?.id ?? currentModel);
      const nextConfig = {
        ...draftRef.current,
        model: nextModel,
      };
      draftRef.current = nextConfig;
      setDraft(nextConfig);
      if (
        JSON.stringify(nextConfig) !== JSON.stringify(savedConfigRef.current)
      ) {
        await persist(nextConfig);
      }
    } catch (error) {
      toast.error(
        t('plugins.modelDiscoverFailed', {
          defaultValue: '拉取模型列表失败',
        }),
        {
          description: errorMessage(error),
        }
      );
    } finally {
      setDiscoveringModels(false);
    }
  };

  if (detail.configSchema['x-vibex-config-surface'] === 'settings') {
    const pageId =
      typeof detail.configSchema['x-vibex-settings-page'] === 'string'
        ? detail.configSchema['x-vibex-settings-page']
        : 'settings';
    return (
      <div className="settings-surface product-plugin-config-shell">
        <dl className="settings-card grid gap-2 p-3 text-sm">
          {properties.map(([key, schema]) => (
            <div
              key={key}
              className="flex items-baseline justify-between gap-4"
            >
              <dt className="text-[color:var(--text-muted)]">
                {schemaTitle(schema, key)}
              </dt>
              <dd className="text-[color:var(--text-primary)]">
                {formatConfigValue(draft[key])}
              </dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="raised-control mt-3 h-8 px-3 text-sm"
          onClick={() =>
            openSettingsSurface(
              navigate,
              `/settings/plugin/${pluginId}/${pageId}`
            )
          }
        >
          {t('plugins.openInSettings')}
        </button>
      </div>
    );
  }
  if (
    detail.configSchema['x-vibex-config-form'] === false ||
    properties.length === 0
  ) {
    return <p className="product-plugin-muted">{t('plugins.noConfig')}</p>;
  }

  return (
    <form
      className="product-plugin-config-shell"
      aria-busy={saving}
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="product-plugin-config settings-card">
        {properties.map(([key, schema]) => (
          <SchemaField
            key={key}
            pluginId={pluginId}
            name={key}
            schema={schema}
            value={draft[key]}
            disabled={!supports('plugin.write')}
            discoveredModels={
              supportsModelDiscovery && key === 'model'
                ? discoveredModels
                : undefined
            }
            discoveringModels={
              supportsModelDiscovery && key === 'model'
                ? discoveringModels
                : undefined
            }
            onDiscoverModels={
              supportsModelDiscovery && key === 'model'
                ? () => void handleDiscoverModels()
                : undefined
            }
            onChange={(value, commit) => updateField(key, value, commit)}
            onCommit={commitDraft}
          />
        ))}
      </div>
    </form>
  );
}
