import {
  OPAQUE_THEME_COLOR_ROLES,
  REQUIRED_THEME_COLOR_ROLES,
  normalizeThemeColor,
  parseThemeDefinition,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeScheme,
} from '@vibex/plugin-sdk';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Download, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { saveTextFile } from '@/lib/saveTextFile';
import {
  deleteUserColorTheme,
  exportColorTheme,
  previewColorTheme,
  saveUserColorTheme,
  selectColorTheme,
} from '@/lib/theme/colorThemeStore';
import {
  onColor,
  resolveThemeColors,
  statusTextColor,
  type ResolvedThemeColors,
} from '@/lib/theme/compileTheme';
import { checkThemeContrast } from '@/lib/theme/themeContrast';
import { cn } from '@/lib/utils';

export const THEME_ROLE_GROUPS: ReadonlyArray<{
  readonly id: string;
  readonly roles: readonly ThemeColorRole[];
}> = [
  {
    id: 'base',
    roles: ['background', 'foreground', 'chrome', 'surface', 'popover'],
  },
  {
    id: 'text',
    roles: ['mutedForeground', 'subtleForeground', 'faintForeground'],
  },
  {
    id: 'controls',
    roles: [
      'border',
      'borderSubtle',
      'control',
      'controlHover',
      'raisedControl',
      'raisedControlHover',
      'track',
    ],
  },
  { id: 'status', roles: ['accent', 'success', 'warning', 'danger', 'info'] },
  { id: 'terminal', roles: ['terminalBackground', 'terminalForeground'] },
  {
    id: 'syntax',
    roles: [
      'syntaxKeyword',
      'syntaxFunction',
      'syntaxConstant',
      'syntaxString',
      'syntaxVariable',
      'syntaxComment',
      'syntaxTag',
      'syntaxPunctuation',
      'syntaxDeleted',
    ],
  },
];

const OPAQUE_ROLES = new Set<ThemeColorRole>(OPAQUE_THEME_COLOR_ROLES);
const REQUIRED_ROLES = new Set<ThemeColorRole>(REQUIRED_THEME_COLOR_ROLES);
const HEX_INPUT = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function parseRoleInput(role: ThemeColorRole, text: string): string | null {
  const trimmed = text.trim();
  if (!HEX_INPUT.test(trimmed)) return null;
  const hex = normalizeThemeColor(
    trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  );
  if (OPAQUE_ROLES.has(role) && hex.length === 9) return null;
  return hex;
}

function ColorRoleField({
  role,
  value,
  derived,
  onChange,
}: {
  role: ThemeColorRole;
  value: string | undefined;
  derived: string;
  onChange: (role: ThemeColorRole, value: string | undefined) => void;
}) {
  const { t } = useTranslation('settings');
  const inputId = useId();
  const [text, setText] = useState(value ?? '');
  const shown = value ?? derived;
  const alpha = shown.length === 9 ? shown.slice(7) : '';
  const roleLabel = t(`appearance.colorTheme.roles.${role}`);
  const invalid = text.trim() !== '' && parseRoleInput(role, text) === null;

  useEffect(() => {
    setText(value ?? '');
  }, [value]);

  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <Label htmlFor={inputId} className="min-w-0 truncate text-sm font-normal">
        {roleLabel}
      </Label>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="color"
          aria-label={t('appearance.colorTheme.editor.swatch', {
            role: roleLabel,
          })}
          className="color-theme-swatch"
          value={shown.slice(0, 7)}
          onChange={(event) => onChange(role, `${event.target.value}${alpha}`)}
        />
        <Input
          id={inputId}
          value={text}
          placeholder={`${derived} · ${t('appearance.colorTheme.editor.auto')}`}
          aria-label={t('appearance.colorTheme.editor.hex', {
            role: roleLabel,
          })}
          aria-invalid={invalid || undefined}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            'h-7 w-[8.5rem] font-mono text-xs',
            invalid && 'border-destructive'
          )}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            if (next.trim() === '' && !REQUIRED_ROLES.has(role)) {
              onChange(role, undefined);
              return;
            }
            const hex = parseRoleInput(role, next);
            if (hex) onChange(role, hex);
          }}
          onBlur={() => setText(value ?? '')}
        />
        <Button
          type="button"
          variant="icon"
          size="icon"
          className="h-7 w-7"
          aria-label={t('appearance.colorTheme.editor.reset')}
          title={t('appearance.colorTheme.editor.reset')}
          disabled={value === undefined || REQUIRED_ROLES.has(role)}
          onClick={() => onChange(role, undefined)}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function ColorThemeSample({ colors }: { colors: ResolvedThemeColors }) {
  const { t } = useTranslation('settings');
  const chips = (['success', 'warning', 'danger', 'info'] as const).map(
    (status) => (
      <span
        key={status}
        className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
        style={{
          color: statusTextColor(colors, status),
          backgroundColor: `color-mix(in srgb, ${colors[status]} 16%, transparent)`,
        }}
      >
        {t(`appearance.colorTheme.roles.${status}`)}
      </span>
    )
  );
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-[var(--radius)] border text-xs"
      style={{
        backgroundColor: colors.background,
        borderColor: colors.border,
        color: colors.foreground,
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5"
        style={{
          backgroundColor: colors.chrome,
          borderBottom: `1px solid ${colors.borderSubtle}`,
        }}
      >
        <span className="font-medium">
          {t('appearance.colorTheme.editor.sample.title')}
        </span>
        <span
          className="ml-auto rounded px-1.5"
          style={{
            backgroundColor: colors.control,
            color: colors.faintForeground,
          }}
        >
          ···
        </span>
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        <div
          className="flex flex-col gap-1.5 rounded-[var(--radius)] p-2"
          style={{
            backgroundColor: colors.surface,
            border: `1px solid ${colors.borderSubtle}`,
          }}
        >
          <span className="text-sm font-semibold">Aa</span>
          <span style={{ color: colors.mutedForeground }}>
            {t('appearance.colorTheme.editor.sample.body')}
          </span>
          <span style={{ color: colors.subtleForeground }}>12:30</span>
          <div className="flex flex-wrap items-center gap-1">{chips}</div>
          <span
            className="self-start rounded-md px-2 py-0.5 font-medium"
            style={{
              backgroundColor: colors.accent,
              color: onColor(colors, colors.accent),
            }}
          >
            {t('appearance.colorTheme.editor.sample.action')}
          </span>
        </div>
        <pre
          className="overflow-hidden rounded-[var(--radius)] p-2 font-mono text-[11px] leading-4"
          style={{
            backgroundColor: colors.terminalBackground,
            color: colors.terminalForeground,
          }}
        >
          <span style={{ color: colors.syntaxKeyword }}>const</span>{' '}
          <span style={{ color: colors.syntaxVariable }}>theme</span>
          <span style={{ color: colors.syntaxPunctuation }}> = </span>
          <span style={{ color: colors.syntaxFunction }}>load</span>
          <span style={{ color: colors.syntaxPunctuation }}>(</span>
          <span style={{ color: colors.syntaxString }}>&apos;ayu&apos;</span>
          <span style={{ color: colors.syntaxPunctuation }}>, </span>
          <span style={{ color: colors.syntaxConstant }}>42</span>
          <span style={{ color: colors.syntaxPunctuation }}>);</span>
          {'\n'}
          <span style={{ color: colors.syntaxComment }}>{'// <Tag /> ok'}</span>
        </pre>
      </div>
    </div>
  );
}

export interface ColorThemeEditorProps {
  readonly initial: ThemeDefinition;
  /** Set when editing a saved user theme in place. */
  readonly savedId: string | null;
  readonly onClose: () => void;
}

export function ColorThemeEditor({
  initial,
  savedId,
  onClose,
}: ColorThemeEditorProps) {
  const { t } = useTranslation('settings');
  const nameId = useId();
  const [draft, setDraft] = useState<ThemeDefinition>(initial);
  const parsed = useMemo(() => parseThemeDefinition(draft), [draft]);
  const valid = parsed.theme ?? null;
  const resolved = useMemo(
    () => resolveThemeColors(valid ?? initial),
    [valid, initial]
  );
  const contrast = useMemo(
    () => (valid ? checkThemeContrast(valid) : []),
    [valid]
  );
  const blocked = contrast.some((issue) => issue.severity === 'error');

  useEffect(() => {
    previewColorTheme(valid);
  }, [valid]);
  useEffect(() => () => previewColorTheme(null), []);

  const setColor = (role: ThemeColorRole, value: string | undefined) => {
    setDraft((current) => {
      const colors: Record<string, string> = { ...current.colors };
      if (value === undefined) delete colors[role];
      else colors[role] = value;
      return { ...current, colors: colors as ThemeColors };
    });
  };

  const setScheme = (scheme: ThemeScheme) =>
    setDraft((current) => ({ ...current, scheme }));

  const save = () => {
    if (!valid || blocked) return;
    const key = saveUserColorTheme(valid);
    selectColorTheme(valid.scheme, key);
    onClose();
  };

  const exportDraft = async () => {
    if (!valid) return;
    try {
      await saveTextFile({
        filename: `${valid.id}.json`,
        content: exportColorTheme(valid),
        mime: 'application/json',
        filterName: 'JSON',
        extension: 'json',
      });
    } catch (error) {
      toast.error(t('appearance.colorTheme.exportFailed'), {
        description: String(error),
      });
    }
  };

  const roleLabel = (role: ThemeColorRole) =>
    t(`appearance.colorTheme.roles.${role}`);

  return (
    <div className="color-theme-editor flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
          <Label htmlFor={nameId}>
            {t('appearance.colorTheme.editor.name')}
          </Label>
          <Input
            id={nameId}
            value={draft.label}
            maxLength={64}
            onChange={(event) =>
              setDraft((current) => ({ ...current, label: event.target.value }))
            }
          />
        </div>
        <SegmentedControl
          value={draft.scheme}
          onChange={(value) => setScheme(value === 'dark' ? 'dark' : 'light')}
          label={t('appearance.colorTheme.editor.scheme')}
          size="sm"
          layout="hug"
        >
          <SegmentedControlItem
            value="light"
            label={t('appearance.colorTheme.editor.schemeLight')}
          />
          <SegmentedControlItem
            value="dark"
            label={t('appearance.colorTheme.editor.schemeDark')}
          />
        </SegmentedControl>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex flex-col gap-4">
          {THEME_ROLE_GROUPS.map((group) => (
            <section key={group.id} className="flex flex-col">
              <h4 className="pb-1 text-xs font-medium text-muted-foreground">
                {t(`appearance.colorTheme.editor.groups.${group.id}`)}
              </h4>
              {group.roles.map((role) => (
                <ColorRoleField
                  key={role}
                  role={role}
                  value={draft.colors[role]}
                  derived={resolved[role]}
                  onChange={setColor}
                />
              ))}
            </section>
          ))}
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('appearance.colorTheme.editor.preview')}
          </h4>
          <ColorThemeSample colors={resolved} />
          <h4 className="text-xs font-medium text-muted-foreground">
            {t('appearance.colorTheme.editor.contrast')}
          </h4>
          {parsed.issues ? (
            <ul className="flex flex-col gap-1 text-xs text-destructive">
              {parsed.issues.map((issue) => (
                <li key={issue.path}>
                  {issue.path} {issue.message}
                </li>
              ))}
            </ul>
          ) : contrast.length === 0 ? (
            <p className="text-xs text-success">
              {t('appearance.colorTheme.editor.contrastOk')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {contrast.map((issue) => (
                <li
                  key={`${issue.foreground}-${issue.background}`}
                  className={
                    issue.severity === 'error'
                      ? 'text-destructive'
                      : 'text-warning'
                  }
                >
                  {t('appearance.colorTheme.editor.contrastIssue', {
                    foreground: roleLabel(issue.foreground),
                    background: roleLabel(issue.background),
                    ratio: issue.ratio.toFixed(2),
                    minimum: issue.minimum,
                  })}
                </li>
              ))}
            </ul>
          )}
          {blocked ? (
            <p className="text-xs text-muted-foreground">
              {t('appearance.colorTheme.editor.contrastBlocked')}
            </p>
          ) : null}
        </aside>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {savedId ? (
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              deleteUserColorTheme(savedId);
              onClose();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('appearance.colorTheme.editor.delete')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          disabled={!valid}
          onClick={() => void exportDraft()}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {t('appearance.colorTheme.export')}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('appearance.colorTheme.editor.cancel')}
          </Button>
          <Button type="button" disabled={!valid || blocked} onClick={save}>
            {t('appearance.colorTheme.editor.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
