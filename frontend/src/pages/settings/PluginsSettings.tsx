import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Download,
  FileUp,
  ImagePlus,
  PackageOpen,
  Pencil,
  Plus,
  Puzzle,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SettingsPageHeader, SettingsSection } from './SettingsUi';
import { desktopApi } from '@/lib/api';
import { pluginApi } from '@/lib/api/plugins';
import type { Plugin, PluginInput } from 'shared/types';

/** Data-URL icons live in the plugin row itself; keep them small. */
const MAX_ICON_BYTES = 200 * 1024;

function emptyInput(defaultHookMessage: string): PluginInput {
  return {
    name: '',
    skill_name: '',
    console_command: '',
    console_url: null,
    hook_message: defaultHookMessage,
    install_command: '',
    author: null,
    icon: null,
    expires_at: null,
    notes: null,
  };
}

function inputFromPlugin(plugin: Plugin): PluginInput {
  return {
    name: plugin.name,
    skill_name: plugin.skill_name,
    console_command: plugin.console_command,
    console_url: plugin.console_url,
    hook_message: plugin.hook_message,
    install_command: plugin.install_command,
    author: plugin.author,
    icon: plugin.icon,
    expires_at: plugin.expires_at,
    notes: plugin.notes,
  };
}

/** RFC3339 → value for <input type="datetime-local"> (local time). */
function toDatetimeLocal(value: string | null): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const offsetMs = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromDatetimeLocal(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatLocalTime(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function isExpired(plugin: Plugin): boolean {
  return (
    plugin.expires_at !== null &&
    new Date(plugin.expires_at).getTime() <= Date.now()
  );
}

export function PluginsSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [draft, setDraft] = useState<PluginInput | null>(null);
  /** Id of the plugin being edited; null while creating a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const iconFileInputRef = useRef<HTMLInputElement | null>(null);
  const manifestFileInputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    try {
      setPlugins(await pluginApi.list());
    } catch (error) {
      toast.error(t('plugins.loadFailed', { error: String(error) }));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // i18next treats `{{…}}` as interpolation, so the literal placeholder
  // tokens must be passed back in as values to survive translation.
  const literalPlaceholders = {
    port: '{{port}}',
    pluginName: '{{pluginName}}',
    skillName: '{{skillName}}',
    consoleCommand: '{{consoleCommand}}',
    consoleUrl: '{{consoleUrl}}',
  };

  const startNew = () => {
    setEditingId(null);
    setDraft(emptyInput(t('plugins.defaultHookMessage', literalPlaceholders)));
  };

  const startEdit = (plugin: Plugin) => {
    setEditingId(plugin.id);
    setDraft(inputFromPlugin(plugin));
  };

  const closeDraft = () => {
    setDraft(null);
    setEditingId(null);
  };

  const patchDraft = (patch: Partial<PluginInput>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  /** Run the skill install for a saved plugin and toast the outcome. */
  const installSkill = useCallback(
    async (plugin: Plugin) => {
      setInstallingId(plugin.id);
      try {
        const installed = await pluginApi.installSkill(plugin.id);
        if (installed.install_status === 'installed') {
          toast.success(t('plugins.installSucceeded', { name: plugin.name }));
        } else {
          toast.error(
            t('plugins.installFailed', {
              name: plugin.name,
              command: plugin.install_command,
              error: installed.install_error ?? '',
            }),
            { duration: 10_000 }
          );
        }
      } catch (error) {
        toast.error(
          t('plugins.installFailed', {
            name: plugin.name,
            command: plugin.install_command,
            error: String(error),
          }),
          { duration: 10_000 }
        );
      } finally {
        setInstallingId(null);
        await reload();
      }
    },
    [reload, t]
  );

  const save = async () => {
    if (!draft) return;
    const required = [
      draft.name,
      draft.skill_name,
      draft.console_command,
      draft.hook_message,
      draft.install_command,
    ];
    if (required.some((value) => !value.trim())) {
      toast.error(t('plugins.requiredFieldsMissing'));
      return;
    }
    setBusy(true);
    try {
      const saved = editingId
        ? await pluginApi.update(editingId, draft)
        : await pluginApi.create(draft);
      toast.success(t(editingId ? 'plugins.updated' : 'plugins.created'));
      closeDraft();
      await reload();
      // Configuring a plugin also installs its skill globally in the
      // background; a failure is surfaced as a toast, never blocks saving.
      void installSkill(saved);
    } catch (error) {
      toast.error(t('plugins.saveFailed', { error: String(error) }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plugin: Plugin) => {
    try {
      await pluginApi.remove(plugin.id);
      await reload();
    } catch (error) {
      toast.error(t('plugins.deleteFailed', { error: String(error) }));
    }
  };

  const handleIconFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_ICON_BYTES) {
      toast.error(t('plugins.iconTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        patchDraft({ icon: reader.result });
      }
    };
    reader.readAsDataURL(file);
  };

  /** Enabling counts as configuring: the plugin appears in the workspace
   *  sidebar and, if its skill isn't installed yet, the install runs now. */
  const toggleEnabled = async (plugin: Plugin, enabled: boolean) => {
    try {
      const updated = await pluginApi.setEnabled(plugin.id, enabled);
      await reload();
      if (enabled && updated.install_status !== 'installed') {
        void installSkill(updated);
      }
    } catch (error) {
      toast.error(t('plugins.toggleFailed', { error: String(error) }));
    }
  };

  const downloadDevKit = async () => {
    try {
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir !== 'string' || !dir) return;
      const kitRoot = await pluginApi.downloadDevKit(dir);
      toast.success(t('plugins.devKitDownloaded', { path: kitRoot }));
      void desktopApi.revealInFileManager(kitRoot).catch(() => undefined);
    } catch (error) {
      toast.error(t('plugins.devKitDownloadFailed', { error: String(error) }));
    }
  };

  const handleManifestFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('manifest must be a JSON object');
      }
      const manifest = parsed as Record<string, unknown>;
      const asString = (key: string) =>
        typeof manifest[key] === 'string' ? (manifest[key] as string) : '';
      const asStringOrNull = (key: string) =>
        typeof manifest[key] === 'string' && (manifest[key] as string).trim()
          ? (manifest[key] as string)
          : null;
      setEditingId(null);
      setDraft({
        name: asString('name'),
        skill_name: asString('skill_name'),
        console_command: asString('console_command'),
        console_url: asStringOrNull('console_url'),
        hook_message: asString('hook_message'),
        install_command: asString('install_command'),
        author: asStringOrNull('author'),
        icon: asStringOrNull('icon'),
        expires_at: asStringOrNull('expires_at'),
        notes: asStringOrNull('notes'),
      });
      toast.success(t('plugins.manifestImported'));
    } catch (error) {
      toast.error(t('plugins.manifestImportFailed', { error: String(error) }));
    }
  };

  const installStatusLabel = (plugin: Plugin) =>
    t(`plugins.status.${plugin.install_status}`, {
      defaultValue: plugin.install_status,
    });

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t('plugins.pageTitle')}
        description={t('plugins.pageDescription')}
      />

      <SettingsSection
        icon={Puzzle}
        title={t('plugins.pageTitle')}
        description={t('plugins.sectionDescription')}
      >
        <div className="mb-3 flex items-center gap-2">
          {draft ? null : (
            <Button size="sm" variant="outline" onClick={startNew}>
              <Plus className="mr-1 h-4 w-4" />
              {t('plugins.newPlugin')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => manifestFileInputRef.current?.click()}
          >
            <FileUp className="mr-1 h-4 w-4" />
            {t('plugins.importManifest')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void downloadDevKit()}
          >
            <PackageOpen className="mr-1 h-4 w-4" />
            {t('plugins.downloadDevKit')}
          </Button>
          <input
            ref={manifestFileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              void handleManifestFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>

        {draft ? (
          <div className="mb-4 space-y-3 rounded-[10px] border border-border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('plugins.name')}
                </label>
                <Input
                  value={draft.name}
                  onChange={(e) => patchDraft({ name: e.target.value })}
                  placeholder={t('plugins.namePlaceholder')}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('plugins.skillName')}
                </label>
                <Input
                  value={draft.skill_name}
                  onChange={(e) => patchDraft({ skill_name: e.target.value })}
                  placeholder={t('plugins.skillNamePlaceholder')}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                {t('plugins.installCommand')}
              </label>
              <Input
                value={draft.install_command}
                onChange={(e) =>
                  patchDraft({ install_command: e.target.value })
                }
                placeholder="npx skills add vibe-motion/skills"
              />
              <p className="text-[11px] text-muted-foreground">
                {t('plugins.installCommandHint')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('plugins.consoleCommand')}
                </label>
                <Input
                  value={draft.console_command}
                  onChange={(e) =>
                    patchDraft({ console_command: e.target.value })
                  }
                  placeholder="npx some-console --port {{port}}"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('plugins.consoleUrl')}
                </label>
                <Input
                  value={draft.console_url ?? ''}
                  onChange={(e) =>
                    patchDraft({ console_url: e.target.value || null })
                  }
                  placeholder="http://127.0.0.1:{{port}}/"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('plugins.consoleHint', literalPlaceholders)}
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                {t('plugins.hookMessage')}
              </label>
              <Textarea
                value={draft.hook_message}
                onChange={(e) => patchDraft({ hook_message: e.target.value })}
                rows={4}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('plugins.hookMessageHint', literalPlaceholders)}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('plugins.author')}
                </label>
                <Input
                  value={draft.author ?? ''}
                  onChange={(e) =>
                    patchDraft({ author: e.target.value || null })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('plugins.icon')}
                </label>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={
                      draft.icon?.startsWith('data:') ? '' : (draft.icon ?? '')
                    }
                    onChange={(e) =>
                      patchDraft({ icon: e.target.value || null })
                    }
                    placeholder={t('plugins.iconPlaceholder')}
                  />
                  {draft.icon?.startsWith('data:') ? (
                    <img
                      src={draft.icon}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded-[5px] object-cover"
                    />
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2"
                    title={t('plugins.uploadIcon')}
                    onClick={() => iconFileInputRef.current?.click()}
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                  </Button>
                  <input
                    ref={iconFileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handleIconFile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  {t('plugins.expiresAt')}
                </label>
                <Input
                  type="datetime-local"
                  value={toDatetimeLocal(draft.expires_at)}
                  onChange={(e) =>
                    patchDraft({
                      expires_at: fromDatetimeLocal(e.target.value),
                    })
                  }
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                {t('plugins.notes')}
              </label>
              <Textarea
                value={draft.notes ?? ''}
                onChange={(e) => patchDraft({ notes: e.target.value || null })}
                rows={2}
              />
            </div>

            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                {t('plugins.saveHint')}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={closeDraft}>
                  {t('common:cancel')}
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={busy}>
                  {t('common:save')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {plugins.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('plugins.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {plugins.map((plugin) => (
              <li
                key={plugin.id}
                className="rounded-[10px] border border-border p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-border">
                      {plugin.icon?.startsWith('data:') ? (
                        <img
                          src={plugin.icon}
                          alt=""
                          className="h-5 w-5 rounded-[4px] object-cover"
                        />
                      ) : plugin.icon?.trim() ? (
                        <span className="text-sm leading-none">
                          {plugin.icon}
                        </span>
                      ) : (
                        <Puzzle className="h-4 w-4 text-muted-foreground" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {plugin.name}
                        {plugin.builtin ? (
                          <span className="ml-1.5 rounded-[4px] border border-border px-1 py-px text-[10px] font-normal text-muted-foreground">
                            {t('plugins.builtinBadge')}
                          </span>
                        ) : null}
                        {isExpired(plugin) ? (
                          <span className="ml-1.5 text-[11px] font-normal text-destructive">
                            {t('plugins.expired')}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {t('plugins.skillSummary', {
                          skill: plugin.skill_name,
                        })}
                        {plugin.author ? ` · ${plugin.author}` : ''}
                        {' · '}
                        <span
                          className={
                            plugin.install_status === 'failed'
                              ? 'text-destructive'
                              : plugin.install_status === 'installed'
                                ? 'text-primary'
                                : ''
                          }
                        >
                          {installStatusLabel(plugin)}
                        </span>
                        {plugin.expires_at
                          ? ` · ${t('plugins.expiresSummary', {
                              time: formatLocalTime(plugin.expires_at),
                            })}`
                          : ''}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={plugin.enabled}
                      title={t('plugins.enableTooltip')}
                      onCheckedChange={(enabled) =>
                        void toggleEnabled(plugin, enabled)
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={installingId === plugin.id}
                      title={t('plugins.reinstall')}
                      onClick={() => void installSkill(plugin)}
                    >
                      <Download className="mr-1 h-3.5 w-3.5" />
                      {installingId === plugin.id
                        ? t('plugins.installing')
                        : t('plugins.reinstall')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      title={t('plugins.edit')}
                      onClick={() => startEdit(plugin)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {!plugin.builtin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive"
                        onClick={() => void remove(plugin)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                {plugin.install_status === 'failed' && plugin.install_error ? (
                  <p className="mt-2 border-t border-border pt-2 text-[11px] text-destructive">
                    {plugin.install_error}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}
