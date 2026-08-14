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

function schemaProperties(detail: PluginProductDetail) {
  const properties = detail.configSchema.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    return [];
  }
  return Object.entries(properties as Record<string, Record<string, unknown>>);
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

  const properties = schemaProperties(detail);
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
        {properties.map(([key, schema]) => {
          const label = String(schema.title ?? key);
          const description = schema.description
            ? String(schema.description)
            : undefined;
          const copy = (
            <span className="product-plugin-config-copy">
              <strong>{label}</strong>
              {description ? <small>{description}</small> : null}
            </span>
          );

          if (schema.type === 'boolean') {
            return (
              <div key={key} className="product-plugin-config-row">
                {copy}
                <Switch
                  aria-label={label}
                  checked={Boolean(draft[key])}
                  disabled={!supports('plugin.write')}
                  onCheckedChange={(value) =>
                    setDraft((current) => ({ ...current, [key]: value }))
                  }
                />
              </div>
            );
          }

          if (Array.isArray(schema.enum)) {
            return (
              <div key={key} className="product-plugin-config-row">
                {copy}
                <Select
                  value={String(draft[key] ?? '')}
                  disabled={!supports('plugin.write')}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, [key]: value }))
                  }
                >
                  <SelectTrigger
                    className="product-plugin-config-control"
                    aria-label={label}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {schema.enum.map((value) => (
                      <SelectItem key={String(value)} value={String(value)}>
                        {String(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          }

          const numeric = schema.type === 'number' || schema.type === 'integer';
          return (
            <label key={key} className="product-plugin-config-row">
              {copy}
              <Input
                className="product-plugin-config-control"
                type={numeric ? 'number' : 'text'}
                aria-label={label}
                value={String(draft[key] ?? '')}
                min={
                  typeof schema.minimum === 'number'
                    ? schema.minimum
                    : undefined
                }
                max={
                  typeof schema.maximum === 'number'
                    ? schema.maximum
                    : undefined
                }
                step={schema.type === 'integer' ? 1 : undefined}
                disabled={!supports('plugin.write')}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((current) => ({
                    ...current,
                    [key]: numeric && value !== '' ? Number(value) : value,
                  }));
                }}
              />
            </label>
          );
        })}
      </div>
      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        disabled={!supports('plugin.write')}
        message={t('plugins.unsavedConfig')}
        onDiscard={() => setDraft(detail.config)}
        onSave={() => void save()}
      />
    </form>
  );
}
