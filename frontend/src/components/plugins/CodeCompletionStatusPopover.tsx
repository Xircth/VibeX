import { Keyboard, Loader2, ScanSearch, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { createPluginControlApi } from '@/lib/api/plugins';
import { openSettingsSurface } from '@/lib/api/settingsWindow';
import { useBackendTransport } from '@/lib/transport';
import { cn } from '@/lib/utils';
import {
  CODE_COMPLETION_SHORTCUT_STORAGE_KEY,
  formatShortcutFromKeyboardEvent,
  savePluginConfigResilient,
} from '@/pages/plugins/PluginConfigForm';
import { errorMessage } from '@/pages/plugins/pluginQueries';

const PLUGIN_ID = 'vibex.code-completion';

interface DiscoveredModelOption {
  id: string;
  name?: string | null;
}

function readStoredShortcut(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(CODE_COMPLETION_SHORTCUT_STORAGE_KEY);
      if (saved && saved.trim()) return saved.trim();
    }
  } catch {
    // ignore storage errors
  }
  return 'Alt+\\';
}

export function CodeCompletionStatusPopover({
  icon,
  label,
}: {
  icon: ReturnType<typeof contributionIconComponent>;
  label: string;
}) {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const Icon = icon;

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({
    enabled: true,
    model: 'gpt-4o-mini',
    triggerMode: 'auto',
    manualShortcut: readStoredShortcut(),
  });
  const [discoveredModels, setDiscoveredModels] = useState<
    DiscoveredModelOption[]
  >([]);
  const [discoveringModels, setDiscoveringModels] = useState(false);
  const [recordingShortcut, setRecordingShortcut] = useState(false);

  const loadCurrentConfig = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await api.productDetail(PLUGIN_ID);
      if (detail?.config && typeof detail.config === 'object') {
        const storedShortcut = readStoredShortcut();
        const nextConfig: Record<string, unknown> = {
          enabled: true,
          triggerMode: 'auto',
          ...detail.config,
          manualShortcut:
            typeof detail.config.manualShortcut === 'string' &&
            detail.config.manualShortcut.trim()
              ? detail.config.manualShortcut.trim()
              : storedShortcut,
        };
        setConfig(nextConfig);
      }
    } catch {
      // Keep current local state if detail fetch fails
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (open) {
      void loadCurrentConfig();
    } else {
      setRecordingShortcut(false);
    }
  }, [open, loadCurrentConfig]);

  useEffect(() => {
    const onConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent)?.detail;
      if (
        detail &&
        detail.pluginId === PLUGIN_ID &&
        detail.config &&
        typeof detail.config === 'object'
      ) {
        setConfig((prev) => ({ ...prev, ...detail.config }));
      }
    };
    window.addEventListener('vibex:plugin-config-updated', onConfigUpdated);
    return () => {
      window.removeEventListener(
        'vibex:plugin-config-updated',
        onConfigUpdated
      );
    };
  }, []);

  const persistConfig = useCallback(
    async (nextConfig: Record<string, unknown>) => {
      setConfig(nextConfig);
      setSaving(true);
      try {
        await savePluginConfigResilient(api, PLUGIN_ID, nextConfig);
        if (typeof nextConfig.enabled === 'boolean') {
          void api
            .invokeContribution(PLUGIN_ID, 'completion.toggle', {
              enabled: nextConfig.enabled,
            })
            .catch(() => undefined);
        }
      } catch (error) {
        toast.error(
          t('plugins.configSaveFailed', { defaultValue: '保存插件配置失败' }),
          {
            description: errorMessage(error),
          }
        );
      } finally {
        setSaving(false);
      }
    },
    [api, t]
  );

  useEffect(() => {
    if (!recordingShortcut) return;
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
        setRecordingShortcut(false);
        return;
      }
      const formatted = formatShortcutFromKeyboardEvent(event);
      if (formatted) {
        setRecordingShortcut(false);
        void persistConfig({
          ...config,
          manualShortcut: formatted,
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [config, persistConfig, recordingShortcut]);

  const handleDiscoverModels = async () => {
    const baseUrl = String(
      config.baseUrl ?? 'https://api.openai.com/v1'
    ).trim();
    if (!baseUrl) {
      toast.warning(
        t('agents.dshProviderUrlRequired', {
          defaultValue: '请先配置接口地址',
        })
      );
      return;
    }
    const apiKey = String(config.apiKey ?? '').trim();
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
      const currentModel = String(config.model ?? '').trim();
      const nextModel = validModels.some((item) => item.id === currentModel)
        ? currentModel
        : (validModels[0]?.id ?? currentModel);
      if (nextModel && nextModel !== currentModel) {
        await persistConfig({
          ...config,
          model: nextModel,
        });
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

  const enabled = Boolean(config.enabled ?? true);
  const currentModel = String(config.model ?? 'gpt-4o-mini').trim();
  const triggerMode =
    config.triggerMode === 'manual' ? 'manual' : 'auto';
  const manualShortcut =
    typeof config.manualShortcut === 'string' && config.manualShortcut.trim()
      ? config.manualShortcut.trim()
      : 'Alt+\\';

  const modelOptions = useMemo(() => {
    const merged: DiscoveredModelOption[] = [];
    const seen = new Set<string>();
    for (const entry of discoveredModels) {
      const id = entry.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push({ id, name: entry.name });
    }
    if (currentModel && !seen.has(currentModel)) {
      merged.unshift({ id: currentModel, name: null });
    }
    return merged;
  }, [currentModel, discoveredModels]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          data-testid="code-completion-status-trigger"
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-sm text-secondary-foreground hover:bg-accent/70',
            !enabled && 'opacity-45'
          )}
        >
          <Icon className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-80 border border-border bg-background p-3.5 shadow-md"
      >
        <div className="flex flex-col gap-3" aria-busy={loading || saving}>
          <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2.5">
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-primary" />
              <span className="text-xs font-semibold text-foreground">
                {t('plugins.official.vibex.code-completion.name', {
                  defaultValue: 'AI代码补全',
                })}
              </span>
            </div>
            <Switch
              aria-label={t(
                'plugins.official.vibex.code-completion.config.enabled.label',
                { defaultValue: '启用行内代码补全' }
              )}
              checked={enabled}
              disabled={saving}
              onCheckedChange={(checked) => {
                void persistConfig({ ...config, enabled: checked });
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('plugins.official.vibex.code-completion.config.model.label', {
                defaultValue: '补全模型',
              })}
            </span>
            <div className="flex items-center gap-1.5">
              <Select
                value={currentModel}
                disabled={saving || modelOptions.length === 0}
                onValueChange={(nextModel) => {
                  void persistConfig({ ...config, model: nextModel });
                }}
              >
                <SelectTrigger
                  aria-label={t(
                    'plugins.official.vibex.code-completion.config.model.label',
                    { defaultValue: '补全模型' }
                  )}
                  className="h-8 flex-1 text-xs"
                >
                  <SelectValue
                    placeholder={t('plugins.selectModelPlaceholder', {
                      defaultValue: '请先拉取模型',
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((item) => (
                    <SelectItem key={item.id} value={item.id} className="text-xs">
                      {item.name &&
                      item.name.trim() &&
                      item.name.trim() !== item.id
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
                className="h-8 shrink-0 px-2.5 text-xs"
                disabled={saving || discoveringModels}
                onClick={() => void handleDiscoverModels()}
              >
                {discoveringModels ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <ScanSearch className="mr-1 h-3 w-3" />
                )}
                {t('plugins.fetchModels', { defaultValue: '拉取模型' })}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t(
                'plugins.official.vibex.code-completion.config.triggerMode.label',
                { defaultValue: '触发方式' }
              )}
            </span>
            <Select
              value={triggerMode}
              disabled={saving}
              onValueChange={(nextMode) => {
                void persistConfig({ ...config, triggerMode: nextMode });
              }}
            >
              <SelectTrigger
                aria-label={t(
                  'plugins.official.vibex.code-completion.config.triggerMode.label',
                  { defaultValue: '触发方式' }
                )}
                className="h-8 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="text-xs">
                  {t('plugins.triggerModeAuto', {
                    defaultValue: '自动触发 (auto)',
                  })}
                </SelectItem>
                <SelectItem value="manual" className="text-xs">
                  {t('plugins.triggerModeManual', {
                    defaultValue: '仅手动快捷键 (manual)',
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t(
                'plugins.official.vibex.code-completion.config.manualShortcut.label',
                { defaultValue: '手动补全快捷键' }
              )}
            </span>
            <div className="flex items-center gap-1.5">
              <Input
                aria-label={t(
                  'plugins.official.vibex.code-completion.config.manualShortcut.label',
                  { defaultValue: '手动补全快捷键' }
                )}
                value={
                  recordingShortcut
                    ? t('plugins.pressShortcutPlaceholder', {
                        defaultValue: '请按下快捷键组合 (Esc 取消)...',
                      })
                    : manualShortcut
                }
                readOnly={recordingShortcut}
                disabled={saving}
                onChange={(event) => {
                  if (!recordingShortcut) {
                    setConfig((prev) => ({
                      ...prev,
                      manualShortcut: event.target.value,
                    }));
                  }
                }}
                onBlur={() => {
                  if (!recordingShortcut) {
                    void persistConfig(config);
                  }
                }}
                onKeyDown={(event) => {
                  if (!recordingShortcut && event.key === 'Enter') {
                    event.preventDefault();
                    void persistConfig(config);
                  }
                }}
                className="h-8 flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant={recordingShortcut ? 'secondary' : 'outline'}
                size="sm"
                className="h-8 shrink-0 px-2.5 text-xs"
                disabled={saving}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setRecordingShortcut((prev) => !prev)}
              >
                <Keyboard className="mr-1 h-3 w-3" />
                {recordingShortcut
                  ? t('plugins.CancelRecordShortcut', {
                      defaultValue: '取消录制',
                    })
                  : t('plugins.recordShortcut', { defaultValue: '录制快捷键' })}
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-end border-t border-border/60 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setOpen(false);
                openSettingsSurface(navigate, `/plugins/${PLUGIN_ID}`);
              }}
            >
              <Settings2 className="mr-1 h-3.5 w-3.5" />
              {t('plugins.openInSettings', { defaultValue: '前往设置修改' })}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
