import { type HostCallTransport } from '@vibex/plugin-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { createPluginControlApi } from '@/lib/api/plugins';
import { configuredBackendTransport } from '@/lib/backendTransport';

export interface JsonSchemaProperty {
  readonly type?: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  readonly title?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly enum?: readonly (string | number)[];
  readonly format?: string;
  readonly secret?: boolean;
  readonly multiline?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly placeholder?: string;
}

export interface PluginSettingsJsonSchema {
  readonly title?: string;
  readonly description?: string;
  readonly type?: 'object';
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly [key: string]: unknown;
}

export interface PluginSchemaSettingsFormProps {
  readonly pluginId: string;
  readonly schema: PluginSettingsJsonSchema | Readonly<Record<string, unknown>>;
  readonly title?: string;
  readonly description?: string;
  readonly callHost?: HostCallTransport;
}

function extractDefaultValues(
  properties: Readonly<Record<string, JsonSchemaProperty>>
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (prop.default !== undefined) {
      defaults[key] = prop.default;
    } else if (prop.type === 'boolean') {
      defaults[key] = false;
    } else if (prop.type === 'number' || prop.type === 'integer') {
      defaults[key] = 0;
    } else if (prop.type === 'array') {
      defaults[key] = [];
    } else {
      defaults[key] = '';
    }
  }
  return defaults;
}

export function PluginSchemaSettingsForm({
  pluginId,
  schema,
  title,
  description,
  callHost,
}: PluginSchemaSettingsFormProps) {
  const typedSchema = schema as PluginSettingsJsonSchema;
  const properties = useMemo(
    () => typedSchema.properties ?? {},
    [typedSchema.properties]
  );
  const defaults = useMemo(
    () => extractDefaultValues(properties),
    [properties]
  );
  const [values, setValues] = useState<Record<string, unknown>>(defaults);
  const [savedValues, setSavedValues] =
    useState<Record<string, unknown>>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const invokeHost = useCallback(
    async <T,>(operation: string, input: unknown): Promise<T> => {
      if (callHost) {
        if (callHost.length === 1) {
          return await (
            callHost as <R>(req: {
              pluginId: string;
              capability: string;
              operation: string;
              input?: never;
            }) => Promise<R>
          )<T>({
            pluginId,
            capability: 'storage',
            operation,
            input: input as never,
          });
        }
        return await (
          callHost as <R>(
            p: string,
            c: string,
            o: string,
            i?: never
          ) => Promise<R>
        )<T>(pluginId, 'storage', operation, input as never);
      }
      const api = createPluginControlApi(configuredBackendTransport);
      return await api.hostCall<T>(pluginId, 'storage', operation, input);
    },
    [callHost, pluginId]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void invokeHost<Record<string, unknown> | null>('settings.get', {})
      .then((loaded) => {
        if (cancelled) return;
        const merged = {
          ...defaults,
          ...(loaded && typeof loaded === 'object' && !Array.isArray(loaded)
            ? loaded
            : {}),
        };
        setValues(merged);
        setSavedValues(merged);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setValues(defaults);
        setSavedValues(defaults);
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [defaults, invokeHost]);

  const isDirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(savedValues),
    [savedValues, values]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      await invokeHost('settings.put', values);
      setSavedValues(values);
      setSavedNotice(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [invokeHost, values]);

  const handleReset = useCallback(() => {
    setValues(defaults);
    setSavedNotice(false);
  }, [defaults]);

  const heading = title ?? typedSchema.title;
  const subheading = description ?? typedSchema.description;

  return (
    <div
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      data-testid={`plugin-schema-settings-${pluginId}`}
    >
      {(heading || subheading) && (
        <div className="space-y-1">
          {heading && (
            <h3 className="text-sm font-semibold text-foreground">{heading}</h3>
          )}
          {subheading && (
            <p className="text-xs text-muted-foreground">{subheading}</p>
          )}
        </div>
      )}

      {loading ? (
        <div className="py-4 text-xs text-muted-foreground">
          Loading settings...
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(properties).map(([key, prop]) => {
            const fieldId = `plugin-setting-${pluginId}-${key}`;
            const label = prop.title ?? key;
            const currentValue = values[key] ?? prop.default ?? '';

            if (prop.type === 'boolean') {
              return (
                <label
                  key={key}
                  htmlFor={fieldId}
                  className="flex cursor-pointer items-start justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                >
                  <div className="space-y-0.5">
                    <span className="block text-xs font-medium text-foreground">
                      {label}
                    </span>
                    {prop.description && (
                      <span className="block text-[11px] text-muted-foreground">
                        {prop.description}
                      </span>
                    )}
                  </div>
                  <input
                    id={fieldId}
                    type="checkbox"
                    checked={Boolean(currentValue)}
                    onChange={(e) => {
                      setSavedNotice(false);
                      setValues((prev) => ({
                        ...prev,
                        [key]: e.target.checked,
                      }));
                    }}
                    className="mt-0.5 h-4 w-4 rounded border-border"
                  />
                </label>
              );
            }

            if (prop.enum && prop.enum.length > 0) {
              return (
                <div key={key} className="space-y-1">
                  <label
                    htmlFor={fieldId}
                    className="block text-xs font-medium text-foreground"
                  >
                    {label}
                  </label>
                  {prop.description && (
                    <p className="text-[11px] text-muted-foreground">
                      {prop.description}
                    </p>
                  )}
                  <select
                    id={fieldId}
                    value={String(currentValue)}
                    onChange={(e) => {
                      setSavedNotice(false);
                      setValues((prev) => ({
                        ...prev,
                        [key]: e.target.value,
                      }));
                    }}
                    className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground"
                  >
                    {prop.enum.map((option) => (
                      <option key={String(option)} value={String(option)}>
                        {String(option)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }

            if (prop.multiline || prop.format === 'textarea') {
              return (
                <div key={key} className="space-y-1">
                  <label
                    htmlFor={fieldId}
                    className="block text-xs font-medium text-foreground"
                  >
                    {label}
                  </label>
                  {prop.description && (
                    <p className="text-[11px] text-muted-foreground">
                      {prop.description}
                    </p>
                  )}
                  <textarea
                    id={fieldId}
                    rows={3}
                    placeholder={prop.placeholder}
                    value={String(currentValue ?? '')}
                    onChange={(e) => {
                      setSavedNotice(false);
                      setValues((prev) => ({
                        ...prev,
                        [key]: e.target.value,
                      }));
                    }}
                    className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
                  />
                </div>
              );
            }

            const isNumeric = prop.type === 'number' || prop.type === 'integer';
            const isPassword =
              prop.secret === true || prop.format === 'password';

            return (
              <div key={key} className="space-y-1">
                <label
                  htmlFor={fieldId}
                  className="block text-xs font-medium text-foreground"
                >
                  {label}
                </label>
                {prop.description && (
                  <p className="text-[11px] text-muted-foreground">
                    {prop.description}
                  </p>
                )}
                <input
                  id={fieldId}
                  type={isPassword ? 'password' : isNumeric ? 'number' : 'text'}
                  min={prop.minimum}
                  max={prop.maximum}
                  placeholder={prop.placeholder}
                  value={
                    Array.isArray(currentValue)
                      ? currentValue.join(', ')
                      : String(currentValue ?? '')
                  }
                  onChange={(e) => {
                    setSavedNotice(false);
                    const raw = e.target.value;
                    const parsed =
                      prop.type === 'array'
                        ? raw
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean)
                        : isNumeric
                          ? raw === ''
                            ? 0
                            : Number(raw)
                          : raw;
                    setValues((prev) => ({
                      ...prev,
                      [key]: parsed,
                    }));
                  }}
                  className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground"
                />
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        {savedNotice && !isDirty && (
          <span className="text-xs text-muted-foreground">Saved</span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReset}
          disabled={saving}
        >
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || !isDirty}
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
