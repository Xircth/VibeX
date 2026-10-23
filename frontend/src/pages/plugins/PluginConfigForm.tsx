import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { TextInput } from '@astryxdesign/core/TextInput';
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

function SchemaField({
  pluginId,
  name,
  schema,
  value,
  disabled,
  onChange,
}: {
  pluginId: string;
  name: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
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
          onValueChange={onChange}
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
        onChange={onChange}
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
        onChange={onChange}
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
            onChange={(next) => onChange({ ...draft, [child]: next })}
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
              onChange={(next) => {
                const copyItems = [...items];
                copyItems[index] = next;
                onChange(copyItems);
              }}
            />
          </div>
        ))}
      </fieldset>
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
            const parsed = Number(event.target.value);
            onChange(Number.isFinite(parsed) ? parsed : event.target.value);
          }}
        />
      ) : (
        <TextInput
          label={label}
          isLabelHidden
          value={stringValue}
          isDisabled={disabled}
          onChange={onChange}
          width="100%"
          className="product-plugin-config-control [&_input]:text-sm"
        />
      )}
    </div>
  );
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
  const [draft, setDraft] = useState(detail.config);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(detail.config), [detail]);

  const persist = async (next: Record<string, unknown>) => {
    setSaving(true);
    try {
      const updated = await api.saveConfig(pluginId, next);
      onSaved(updated);
    } catch (error) {
      toast.error(t('plugins.configSaveFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const updateField = (key: string, value: unknown) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    void persist(next);
  };

  const properties = schemaProperties(detail.configSchema);
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
            disabled={!supports('plugin.write') || saving}
            onChange={(value) => updateField(key, value)}
          />
        ))}
      </div>
    </form>
  );
}
