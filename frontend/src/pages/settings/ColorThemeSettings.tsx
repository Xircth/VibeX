import type { ThemeDefinition, ThemeScheme } from '@vibex/plugin-sdk';
import { Copy, Pencil, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import {
  parseColorThemeFile,
  saveUserColorTheme,
  selectColorTheme,
  uniqueUserThemeId,
  type ColorThemeEntry,
} from '@/lib/theme/colorThemeStore';
import { resolveThemeColors } from '@/lib/theme/compileTheme';
import { useColorThemes } from '@/lib/theme/useColorThemes';

import { ColorThemeEditor } from './ColorThemeEditor';

interface EditorTarget {
  readonly initial: ThemeDefinition;
  readonly savedId: string | null;
}

function ThemeSwatches({ theme }: { theme: ThemeDefinition }) {
  const colors = resolveThemeColors(theme);
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-7 shrink-0 overflow-hidden rounded-none border border-[var(--border-subtle)]"
    >
      <span className="flex-1" style={{ backgroundColor: colors.background }} />
      <span className="flex-1" style={{ backgroundColor: colors.foreground }} />
      <span className="flex-1" style={{ backgroundColor: colors.accent }} />
    </span>
  );
}

function ColorThemeRow({
  scheme,
  entries,
  active,
  onEdit,
}: {
  scheme: ThemeScheme;
  entries: readonly ColorThemeEntry[];
  active: ColorThemeEntry;
  onEdit: (target: EditorTarget) => void;
}) {
  const { t } = useTranslation('settings');
  const label = t(`appearance.colorTheme.${scheme}`);
  const editsInPlace = active.source === 'user';

  return (
    <div className="settings-row">
      <div>
        <Label>{label}</Label>
      </div>
      <div className="settings-inline-group">
        <Select
          value={active.key}
          onValueChange={(key) => selectColorTheme(scheme, key)}
        >
          <SelectTrigger
            className="w-56"
            aria-label={t('appearance.colorTheme.picker', { scheme: label })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {entries.map((entry) => (
              <SelectItem key={entry.key} value={entry.key}>
                <span className="flex min-w-0 items-center gap-2">
                  <ThemeSwatches theme={entry.theme} />
                  <span className="truncate">{entry.theme.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t(`appearance.colorTheme.source.${entry.source}`)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={
            editsInPlace
              ? t('appearance.colorTheme.edit')
              : t('appearance.colorTheme.duplicate')
          }
          title={
            editsInPlace
              ? t('appearance.colorTheme.edit')
              : t('appearance.colorTheme.duplicate')
          }
          onClick={() =>
            onEdit(
              editsInPlace
                ? { initial: active.theme, savedId: active.theme.id }
                : {
                    initial: {
                      ...active.theme,
                      id: uniqueUserThemeId(`${active.theme.id}-custom`),
                      label: t('appearance.colorTheme.copyLabel', {
                        label: active.theme.label,
                      }).slice(0, 64),
                    },
                    savedId: null,
                  }
            )
          }
        >
          {editsInPlace ? (
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}

/** Light and dark color theme pickers, theme import, and the editor. */
export function ColorThemeSettings() {
  const { t } = useTranslation('settings');
  const snapshot = useColorThemes();
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const result = parseColorThemeFile(await file.text());
    if (result.issues) {
      toast.error(t('appearance.colorTheme.importFailed'), {
        description: result.issues
          .slice(0, 4)
          .map((issue) => `${issue.path} ${issue.message}`)
          .join('\n'),
      });
      return;
    }
    const keys = result.themes.map((theme) =>
      saveUserColorTheme({ ...theme, id: uniqueUserThemeId(theme.id) })
    );
    const [first] = result.themes;
    if (keys.length === 1) {
      selectColorTheme(first.scheme, keys[0]);
      toast.success(
        t('appearance.colorTheme.importedOne', { label: first.label })
      );
    } else {
      toast.success(
        t('appearance.colorTheme.importedMany', { count: keys.length })
      );
    }
  };

  if (editing) {
    return (
      <ColorThemeEditor
        key={editing.savedId ?? editing.initial.id}
        initial={editing.initial}
        savedId={editing.savedId}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <>
      {(['light', 'dark'] as const).map((scheme) => {
        const active = snapshot.active[scheme];
        const entries = snapshot.themes.filter(
          (entry) => entry.theme.scheme === scheme
        );
        return (
          <ColorThemeRow
            key={scheme}
            scheme={scheme}
            entries={
              entries.some((entry) => entry.key === active.key)
                ? entries
                : [...entries, active]
            }
            active={active}
            onEdit={setEditing}
          />
        );
      })}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          {t('appearance.colorTheme.import')}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => void importFile(event)}
        />
      </div>
    </>
  );
}
