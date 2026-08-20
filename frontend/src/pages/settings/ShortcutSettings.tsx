import { useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SettingsActionBar } from './SettingsUi';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUserSystem } from '@/components/ConfigProvider';
import { type Config, type SendMessageShortcut } from 'shared/types';
import { chordFromEvent, formatChord } from '@/keyboard/chord';
import {
  formatSequentialKeys,
  getConfigurableKeyBindings,
  findChordConflicts,
  sequentialBindings,
  type EffectiveKeyBinding,
} from '@/keyboard/registry';
import { useKeyBindingOverridesStore } from '@/keyboard/useKeyBindingOverrides';

function groupBy<T>(items: T[], key: (item: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    (map.get(k) ?? map.set(k, []).get(k)!).push(item);
  }
  return [...map.entries()];
}

/**
 * Registry ids/groups become i18n key segments; strip the characters i18next
 * treats specially (':' is its namespace separator) plus spaces/commas.
 */
function shortcutKeySlug(value: string): string {
  return value.replace(/[:,\s]+/g, '_');
}

type Translate = (key: string, options?: { defaultValue: string }) => string;

/** Localized binding description, falling back to the registry's English. */
function bindingLabel(
  t: Translate,
  id: string,
  fallbackDescription: string
): string {
  return t(`shortcuts.bindings.${shortcutKeySlug(id)}`, {
    defaultValue: fallbackDescription,
  });
}

function groupLabel(t: Translate, group: string): string {
  return t(`shortcuts.groups.${shortcutKeySlug(group)}`, {
    defaultValue: group,
  });
}

function scopeLabel(t: Translate, scope: string): string {
  return t(`shortcuts.scopes.${shortcutKeySlug(scope)}`, {
    defaultValue: scope,
  });
}

/** A single rebindable shortcut row: shows keys, captures a new chord, resets. */
function ShortcutRow({
  binding,
  conflicts,
  capturing,
  captureError,
  onStartCapture,
  onReset,
}: {
  binding: EffectiveKeyBinding;
  conflicts: EffectiveKeyBinding[];
  capturing: boolean;
  captureError: boolean;
  onStartCapture: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);

  return (
    <div className="settings-row flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {bindingLabel(t, binding.id, binding.description)}
          </span>
          {binding.scopes?.map((scope) => (
            <span
              key={scope}
              className="settings-meta-chip px-1.5 py-0.5 text-[10px]"
            >
              {scopeLabel(t, scope)}
            </span>
          ))}
          {conflicts.length > 0 ? (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] text-destructive"
              title={conflicts
                .map((c) =>
                  t('shortcuts.conflictWith', {
                    description: bindingLabel(t, c.id, c.description),
                  })
                )
                .join('\n')}
            >
              {t('shortcuts.conflict')}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {capturing ? (
          <span className="text-[11px] text-muted-foreground">
            {captureError
              ? t('shortcuts.unsupportedKey')
              : t('shortcuts.capturing')}
          </span>
        ) : (
          <div className="flex flex-wrap justify-end gap-1">
            {binding.keys.map((key) => (
              <kbd
                key={key}
                className="settings-kbd px-2 py-1 text-[11px] font-mono"
              >
                {formatChord(key)}
              </kbd>
            ))}
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={onStartCapture}
          disabled={capturing}
        >
          {t('shortcuts.rebind')}
        </Button>
        {binding.overridden ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={onReset}
            title={t('common:reset')}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ShortcutSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { config, loading, updateAndSaveConfig } = useUserSystem();
  const [draft, setDraft] = useState<Config | null>(() =>
    config ? structuredClone(config) : null
  );
  const [saving, setSaving] = useState(false);

  const overrides = useKeyBindingOverridesStore((s) => s.overrides);
  const setOverride = useKeyBindingOverridesStore((s) => s.setOverride);
  const clearOverride = useKeyBindingOverridesStore((s) => s.clearOverride);
  const clearAll = useKeyBindingOverridesStore((s) => s.clearAll);

  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState(false);

  useEffect(() => {
    if (config) {
      setDraft(structuredClone(config));
    }
  }, [config]);

  // Global capture-phase listener while rebinding — intercepts the chord before
  // the app's own hotkeys can fire on it.
  useEffect(() => {
    if (!capturingId) return;

    const handler = (event: KeyboardEvent) => {
      // Ignore lone modifier presses so the user can hold e.g. ⌘ then a key.
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // Bare Escape cancels the capture (can't rebind onto Escape in v1).
      if (
        event.key === 'Escape' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        setCapturingId(null);
        setCaptureError(false);
        return;
      }

      const chord = chordFromEvent(event);
      if (!chord) {
        setCaptureError(true);
        return;
      }
      setOverride(capturingId, chord);
      setCapturingId(null);
      setCaptureError(false);
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () =>
      window.removeEventListener('keydown', handler, { capture: true });
  }, [capturingId, setOverride]);

  const effective = useMemo(
    () => getConfigurableKeyBindings(overrides),
    [overrides]
  );
  const groupedBindings = useMemo(
    () => groupBy(effective, (b) => b.group ?? 'Other'),
    [effective]
  );
  const hasOverrides = Object.keys(overrides).length > 0;

  const hasUnsavedChanges = useMemo(
    () =>
      !!config &&
      !!draft &&
      draft.send_message_shortcut !== config.send_message_shortcut,
    [config, draft]
  );

  const sendShortcutOptions = useMemo(
    () => [
      {
        value: 'ModifierEnter' as SendMessageShortcut,
        label: t('shortcuts.sendModifierEnterLabel'),
        helper: t('shortcuts.sendModifierEnterHelper'),
      },
      {
        value: 'Enter' as SendMessageShortcut,
        label: t('shortcuts.sendEnterLabel'),
        helper: t('shortcuts.sendEnterHelper'),
      },
    ],
    [t]
  );

  const selectedShortcutHelper = useMemo(
    () =>
      sendShortcutOptions.find(
        (option) => option.value === draft?.send_message_shortcut
      )?.helper ?? '',
    [draft?.send_message_shortcut, sendShortcutOptions]
  );

  const updateSendShortcut = useCallback((value: SendMessageShortcut) => {
    setDraft((previous) =>
      previous ? { ...previous, send_message_shortcut: value } : previous
    );
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await updateAndSaveConfig(draft);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (config) {
      setDraft(structuredClone(config));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!draft) {
    return null;
  }

  return (
    <div className="settings-content">
      <div className="space-y-3">
        <section className="settings-section space-y-3">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">
              {t('shortcuts.inputTitle')}
            </h3>
          </div>
          <div className="settings-card overflow-hidden rounded-lg border">
            <div className="settings-row flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {t('shortcuts.sendLabel')}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedShortcutHelper}
                </p>
              </div>
              <Select
                value={draft.send_message_shortcut}
                onValueChange={(value) =>
                  updateSendShortcut(value as SendMessageShortcut)
                }
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {sendShortcutOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>

        <section className="settings-section space-y-3">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Keyboard className="h-4 w-4 text-muted-foreground" />
                {t('shortcuts.sectionTitle')}
              </h3>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {t('shortcuts.sectionDescription')}
              </p>
            </div>
            {hasOverrides ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-xs"
                onClick={() => clearAll()}
              >
                <RotateCcw className="mr-1 h-3 w-3" />
                {t('shortcuts.resetAll')}
              </Button>
            ) : null}
          </div>

          <div className="space-y-4">
            {groupedBindings.map(([group, bindings]) => (
              <div key={group} className="space-y-1.5">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {groupLabel(t, group)}
                </div>
                <div className="settings-card divide-y divide-[var(--border-content)] overflow-hidden rounded-lg border">
                  {bindings.map((binding) => (
                    <ShortcutRow
                      key={binding.id}
                      binding={binding}
                      conflicts={findChordConflicts(binding, effective)}
                      capturing={capturingId === binding.id}
                      captureError={captureError}
                      onStartCapture={() => {
                        setCaptureError(false);
                        setCapturingId(binding.id);
                      }}
                      onReset={() => clearOverride(binding.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="settings-section space-y-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Keyboard className="h-4 w-4 text-muted-foreground" />
              {t('shortcuts.sequentialTitle')}
            </h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {t('shortcuts.sequentialDescription')}
            </p>
          </div>
          <div className="settings-card divide-y divide-[var(--border-content)] overflow-hidden rounded-lg border">
            {sequentialBindings.map((binding) => (
              <div
                key={binding.id}
                className="settings-row flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">
                      {bindingLabel(t, binding.id, binding.description)}
                    </span>
                    <span className="settings-meta-chip px-1.5 py-0.5 text-[10px]">
                      {groupLabel(t, binding.group)}
                    </span>
                  </div>
                </div>
                <kbd className="settings-kbd shrink-0 px-2 py-1 text-[11px] font-mono">
                  {formatSequentialKeys(binding.keys)}
                </kbd>
              </div>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('shortcuts.readOnlyNote')}
          </p>
        </section>
      </div>

      <SettingsActionBar
        dirty={hasUnsavedChanges}
        saving={saving}
        onDiscard={handleDiscard}
        onSave={handleSave}
        message={t('shortcuts.unsaved')}
      />
    </div>
  );
}
