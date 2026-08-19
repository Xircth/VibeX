import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
import { useBackendCapabilities, useBackendTransport } from '@/lib/transport';
import { SettingsActionBar } from '@/pages/settings/SettingsUi';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type JsonSchema = Record<string, unknown>;

function schemaProperties(schema: JsonSchema): Array<[string, JsonSchema]> {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return [];
  }
  return Object.entries(properties as Record<string, JsonSchema>);
}

function SchemaField({
  name,
  schema,
  value,
  disabled,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const label = String(schema.title ?? name);
  const description =
    typeof schema.description === 'string' ? schema.description : undefined;
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
                {String(item)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <div className="product-plugin-config-row">
        {copy}
        <Switch
          aria-label={label}
          checked={Boolean(value)}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </div>
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
      schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
        ? (schema.items as JsonSchema)
        : { type: 'string' };
    return (
      <fieldset className="product-plugin-config-block">
        <legend>{copy}</legend>
        {items.map((item, index) => (
          <div key={`${name}-${index}`} className="product-plugin-config-row">
            <SchemaField
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

  const inputType = schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text';
  return (
    <div className="product-plugin-config-row">
      {copy}
      <Input
        aria-label={label}
        type={inputType}
        className="product-plugin-config-control"
        disabled={disabled}
        value={value == null ? '' : String(value)}
        onChange={(event) => {
          if (inputType === 'number') {
            const parsed = Number(event.target.value);
            onChange(Number.isFinite(parsed) ? parsed : event.target.value);
            return;
          }
          onChange(event.target.value);
        }}
      />
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
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const { supports } = useBackendCapabilities();
  const [draft, setDraft] = useState(detail.config);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail.config);

  useEffect(() => setDraft(detail.config), [detail]);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.saveConfig(pluginId, draft);
      onSaved(updated);
      toast.success(t('plugins.configSaved'));
    } catch (error) {
      toast.error(t('plugins.configSaveFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const properties = schemaProperties(detail.configSchema);
  if (properties.length === 0) {
    return <p className="product-plugin-muted">{t('plugins.noConfig')}</p>;
  }

  return (
    <form
      className="product-plugin-config-shell"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="product-plugin-config settings-card">
        {properties.map(([key, schema]) => (
          <SchemaField
            key={key}
            name={key}
            schema={schema}
            value={draft[key]}
            disabled={!supports('plugin.write')}
            onChange={(value) =>
              setDraft((current) => ({ ...current, [key]: value }))
            }
          />
        ))}
      </div>
      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        disabled={!supports('plugin.write')}
        onReset={() => setDraft(detail.config)}
      />
    </form>
  );
}
