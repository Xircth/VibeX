import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BellRing,
  History,
  KeyRound,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Search,
  SendHorizontal,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  chatChannelApi,
  type ChatChannel,
  type ChatChannelPayload,
} from '@/lib/api';
import { SETTINGS_CHANGED_EVENT } from '@/lib/frontendPreferences';
import type { ChatChannelMessageLog } from 'shared/types';

import { SettingsPageHeader, SettingsSection } from './SettingsUi';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const CHANNEL_KINDS = [
  { value: 'telegram' },
  { value: 'feishu' },
  { value: 'weixin' },
  { value: 'qq' },
  { value: 'webhook' },
];

const EVENT_OPTIONS = [
  { value: 'prompt_started', labelKey: 'chatChannels.events.promptStarted' },
  { value: 'prompt_finished', labelKey: 'chatChannels.events.promptFinished' },
  {
    value: 'permission_requested',
    labelKey: 'chatChannels.events.permissionRequested',
  },
  { value: 'error', labelKey: 'chatChannels.events.error' },
  {
    value: 'connection_status_changed',
    labelKey: 'chatChannels.events.connectionStatusChanged',
  },
  { value: 'session_created', labelKey: 'chatChannels.events.sessionCreated' },
  { value: 'turn_completed', labelKey: 'chatChannels.events.turnCompleted' },
];

interface SecretMeta {
  label: string;
  placeholder: string;
  optional: boolean;
}

function secretMeta(kind: string, t: Translate): SecretMeta {
  switch (kind) {
    case 'telegram':
      return {
        label: 'Bot Token',
        placeholder: t('chatChannels.secret.telegramPlaceholder'),
        optional: false,
      };
    case 'feishu':
      return {
        label: 'App Secret',
        placeholder: t('chatChannels.secret.feishuPlaceholder'),
        optional: false,
      };
    case 'weixin':
      return {
        label: 'Webhook Key',
        placeholder: t('chatChannels.secret.weixinPlaceholder'),
        optional: false,
      };
    case 'qq':
      return {
        label: 'Access Token',
        placeholder: t('chatChannels.secret.qqPlaceholder'),
        optional: true,
      };
    default:
      return {
        label: 'Bearer Token',
        placeholder: t('chatChannels.secret.defaultPlaceholder'),
        optional: true,
      };
  }
}

function kindLabel(kind: string, t: Translate): string {
  switch (kind) {
    case 'telegram':
      return 'Telegram';
    case 'feishu':
      return t('chatChannels.kinds.feishu');
    case 'weixin':
      return t('chatChannels.kinds.weixin');
    case 'qq':
      return t('chatChannels.kinds.qq');
    case 'webhook':
      return t('chatChannels.kinds.webhook');
    default:
      return kind;
  }
}

function cfgStr(
  config: Record<string, unknown> | undefined,
  key: string
): string {
  const value = config?.[key];
  return typeof value === 'string' ? value : '';
}

/** Read an `authorized_senders` array back into a newline-joined edit string. */
function cfgSendersText(config: Record<string, unknown> | undefined): string {
  const value = config?.authorized_senders;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) =>
      typeof item === 'number' ? String(item) : String(item ?? '')
    )
    .filter((item) => item.trim().length > 0)
    .join('\n');
}

/** Parse the allowlist edit box (comma/whitespace/newline separated) into ids. */
function parseSenders(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    )
  );
}

/** Channel kinds that accept inbound commands and therefore gate on an allowlist. */
const INBOUND_KINDS = new Set(['telegram', 'feishu', 'qq']);

function channelSummary(channel: ChatChannel, t: Translate): string {
  const c = channel.config ?? {};
  switch (channel.kind) {
    case 'telegram':
      return `chat ${cfgStr(c, 'chat_id') || t('chatChannels.summary.notSet')}`;
    case 'feishu':
      return cfgStr(c, 'app_id') || t('chatChannels.summary.noAppId');
    case 'weixin':
      return t('chatChannels.summary.weixinGroupBot');
    case 'qq':
      return `${
        cfgStr(c, 'message_type') === 'private'
          ? t('chatChannels.summary.private')
          : t('chatChannels.summary.group')
      } ${cfgStr(c, 'target_id') || t('chatChannels.summary.notSet')}`;
    default:
      return cfgStr(c, 'webhook_url') || t('chatChannels.summary.noWebhook');
  }
}

interface ChannelDraft {
  name: string;
  kind: string;
  enabled: boolean;
  token: string;
  chat_id: string;
  app_id: string;
  base_url: string;
  ws_url: string;
  message_type: string;
  target_id: string;
  webhook_url: string;
  authorized_senders: string;
}

function emptyDraft(): ChannelDraft {
  return {
    name: '',
    kind: 'telegram',
    enabled: true,
    token: '',
    chat_id: '',
    app_id: '',
    base_url: 'http://127.0.0.1:3000',
    ws_url: '',
    message_type: 'group',
    target_id: '',
    webhook_url: '',
    authorized_senders: '',
  };
}

function draftFromChannel(channel: ChatChannel): ChannelDraft {
  const c = channel.config ?? {};
  return {
    name: channel.name,
    kind: channel.kind,
    enabled: channel.enabled,
    token: '',
    chat_id: cfgStr(c, 'chat_id'),
    app_id: cfgStr(c, 'app_id'),
    base_url: cfgStr(c, 'base_url') || 'http://127.0.0.1:3000',
    ws_url: cfgStr(c, 'ws_url'),
    message_type: cfgStr(c, 'message_type') || 'group',
    target_id: cfgStr(c, 'target_id'),
    webhook_url: cfgStr(c, 'webhook_url'),
    authorized_senders: cfgSendersText(c),
  };
}

function buildConfig(draft: ChannelDraft): Record<string, unknown> {
  const senders = parseSenders(draft.authorized_senders);
  switch (draft.kind) {
    case 'telegram':
      return { chat_id: draft.chat_id.trim(), authorized_senders: senders };
    case 'feishu':
      return {
        app_id: draft.app_id.trim(),
        chat_id: draft.chat_id.trim(),
        authorized_senders: senders,
      };
    case 'weixin':
      return {};
    case 'qq':
      return {
        base_url: draft.base_url.trim(),
        ws_url: draft.ws_url.trim(),
        message_type: draft.message_type,
        target_id: draft.target_id.trim(),
        authorized_senders: senders,
      };
    default:
      return { webhook_url: draft.webhook_url.trim() };
  }
}

function payloadFromDraft(draft: ChannelDraft): ChatChannelPayload {
  return {
    name: draft.name,
    kind: draft.kind,
    enabled: draft.enabled,
    config: buildConfig(draft),
    token: draft.token.trim() ? draft.token.trim() : null,
  };
}

function payloadFromChannel(
  channel: ChatChannel,
  enabled: boolean
): ChatChannelPayload {
  return {
    name: channel.name,
    kind: channel.kind,
    enabled,
    config: channel.config ?? {},
    token: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatChannelSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  // Create / edit dialog state.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<ChatChannel | null>(
    null
  );
  const [draft, setDraft] = useState<ChannelDraft>(() => emptyDraft());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Delivery/audit log viewer (P2-7).
  const [logChannelId, setLogChannelId] = useState<string | null>(null);
  const [logs, setLogs] = useState<ChatChannelMessageLog[]>([]);

  const toggleLogs = useCallback(
    async (channelId: string) => {
      if (logChannelIdRef.current === channelId) {
        setLogChannelId(null);
        return;
      }
      try {
        setLogs(await chatChannelApi.messageLogs(channelId, 15));
        setLogChannelId(channelId);
      } catch (error) {
        toast.error(t('chatChannels.loadLogsFailed', { error: String(error) }));
      }
    },
    [t]
  );
  const logChannelIdRef = useRef(logChannelId);
  logChannelIdRef.current = logChannelId;

  // App-level notification settings.
  const [eventFilter, setEventFilter] = useState<string[]>([]);
  const [savedEventFilter, setSavedEventFilter] = useState<string[]>([]);
  const [prefix, setPrefix] = useState('/vibex');
  const [savedPrefix, setSavedPrefix] = useState('/vibex');
  const [includePromptText, setIncludePromptText] = useState(false);
  const [savingEvents, setSavingEvents] = useState(false);
  const [savingPrefix, setSavingPrefix] = useState(false);

  const secret = secretMeta(draft.kind, t);

  const visibleChannels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return channels;
    return channels.filter((channel) =>
      channel.name.toLowerCase().includes(query)
    );
  }, [channels, search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [channelList, filter, commandPrefix, promptText] =
        await Promise.all([
          chatChannelApi.list(),
          chatChannelApi.getEventFilter(),
          chatChannelApi.getCommandPrefix(),
          chatChannelApi.getIncludePromptText(),
        ]);
      setChannels(channelList);
      setEventFilter(filter.enabled_events);
      setSavedEventFilter(filter.enabled_events);
      setPrefix(commandPrefix.prefix);
      setSavedPrefix(commandPrefix.prefix);
      setIncludePromptText(promptText);
    } catch (error) {
      toast.error(t('chatChannels.loadFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const reloadFromJson = () => {
      const notificationDraftDirty =
        JSON.stringify(eventFilter) !== JSON.stringify(savedEventFilter) ||
        prefix !== savedPrefix;
      if (!dialogOpen && !notificationDraftDirty) void refresh();
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, reloadFromJson);
    return () =>
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reloadFromJson);
  }, [dialogOpen, eventFilter, prefix, refresh, savedEventFilter, savedPrefix]);

  const openCreate = () => {
    setEditingChannel(null);
    setDraft(emptyDraft());
    setDialogOpen(true);
  };

  const openEdit = (channel: ChatChannel) => {
    setEditingChannel(channel);
    setDraft(draftFromChannel(channel));
    setDialogOpen(true);
  };

  const saveChannel = async () => {
    if (!draft.name.trim()) {
      toast.error(t('chatChannels.nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const payload = payloadFromDraft(draft);
      const channel = editingChannel
        ? await chatChannelApi.update(editingChannel.id, payload)
        : await chatChannelApi.create(payload);
      await refresh();
      toast.success(
        editingChannel
          ? t('chatChannels.channelSaved')
          : t('chatChannels.channelCreated')
      );
      if (editingChannel) {
        setEditingChannel(channel);
        setDraft(draftFromChannel(channel));
      } else {
        setDialogOpen(false);
      }
    } catch (error) {
      toast.error(t('chatChannels.saveFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (channel: ChatChannel, enabled: boolean) => {
    setChannels((previous) =>
      previous.map((item) =>
        item.id === channel.id ? { ...item, enabled } : item
      )
    );
    try {
      await chatChannelApi.update(
        channel.id,
        payloadFromChannel(channel, enabled)
      );
    } catch (error) {
      setChannels((previous) =>
        previous.map((item) =>
          item.id === channel.id ? { ...item, enabled: !enabled } : item
        )
      );
      toast.error(t('chatChannels.statusUpdateFailed'), {
        description: errorMessage(error),
      });
    }
  };

  const deleteChannel = (channel: ChatChannel) => {
    const toastId = toast.warning(
      t('chatChannels.deleteConfirm', { name: channel.name }),
      {
        duration: 8000,
        action: {
          label: t('common:delete'),
          onClick: async () => {
            toast.dismiss(toastId);
            try {
              await chatChannelApi.delete(channel.id);
              if (editingChannel?.id === channel.id) {
                setDialogOpen(false);
              }
              await refresh();
              toast.success(t('chatChannels.channelDeleted'));
            } catch (error) {
              toast.error(t('chatChannels.deleteFailed'), {
                description: errorMessage(error),
              });
            }
          },
        },
        cancel: {
          label: t('common:cancel'),
          onClick: () => toast.dismiss(toastId),
        },
      }
    );
  };

  const removeToken = async () => {
    if (!editingChannel) return;
    try {
      await chatChannelApi.deleteToken(editingChannel.id);
      const updated = { ...editingChannel, has_token: false };
      setChannels((previous) =>
        previous.map((channel) =>
          channel.id === editingChannel.id ? updated : channel
        )
      );
      setEditingChannel(updated);
      toast.success(t('chatChannels.secretRemoved'));
    } catch (error) {
      toast.error(t('chatChannels.secretRemoveFailed'), {
        description: errorMessage(error),
      });
    }
  };

  const testChannel = async () => {
    if (!editingChannel) return;
    setTesting(true);
    try {
      const result = await chatChannelApi.test(editingChannel.id);
      toast[result.ok ? 'success' : 'error'](result.message);
    } catch (error) {
      toast.error(t('chatChannels.testFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setTesting(false);
    }
  };

  const toggleEvent = (eventName: string, checked: boolean) => {
    setEventFilter((previous) =>
      checked
        ? [...new Set([...previous, eventName])]
        : previous.filter((item) => item !== eventName)
    );
  };

  const saveEventFilter = async () => {
    setSavingEvents(true);
    try {
      const saved = await chatChannelApi.setEventFilter({
        enabled_events: eventFilter,
      });
      setEventFilter(saved.enabled_events);
      setSavedEventFilter(saved.enabled_events);
      toast.success(t('chatChannels.eventFilterSaved'));
    } catch (error) {
      toast.error(t('chatChannels.eventFilterSaveFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSavingEvents(false);
    }
  };

  const savePrefix = async () => {
    setSavingPrefix(true);
    try {
      const saved = await chatChannelApi.setCommandPrefix({ prefix });
      setPrefix(saved.prefix);
      setSavedPrefix(saved.prefix);
      toast.success(t('chatChannels.prefixSaved'));
    } catch (error) {
      toast.error(t('chatChannels.prefixSaveFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSavingPrefix(false);
    }
  };

  const togglePromptText = async (enabled: boolean) => {
    setIncludePromptText(enabled);
    try {
      await chatChannelApi.setIncludePromptText(enabled);
    } catch (error) {
      setIncludePromptText(!enabled);
      toast.error(t('chatChannels.settingSaveFailed'), {
        description: errorMessage(error),
      });
    }
  };

  const updateDraft = (patch: Partial<ChannelDraft>) =>
    setDraft((previous) => ({ ...previous, ...patch }));

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title={t('chatChannels.title')}
        description={t('chatChannels.description')}
      />

      <div className="settings-sections">
        <SettingsSection
          icon={SendHorizontal}
          title={t('chatChannels.channelsTitle')}
          description={t('chatChannels.channelsCount', {
            count: channels.length,
          })}
          action={
            <Button size="sm" className="h-8 text-xs" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('chatChannels.newChannel')}
            </Button>
          }
        >
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <SendHorizontal className="h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm font-medium">
                {t('chatChannels.emptyTitle')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('chatChannels.emptyHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {channels.length > 4 ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('chatChannels.searchPlaceholder')}
                    className="pl-8"
                  />
                </div>
              ) : null}

              <div className="space-y-1">
                {visibleChannels.length === 0 ? (
                  <div className="settings-empty-state py-4 text-center">
                    {t('chatChannels.noMatch')}
                  </div>
                ) : (
                  visibleChannels.map((channel) => (
                    <div key={channel.id}>
                      <div className="group flex items-center gap-3 rounded-md px-2.5 py-2 transition-colors hover:bg-[var(--surface-control-hover)]">
                        <button
                          type="button"
                          onClick={() => openEdit(channel)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">
                              {channel.name}
                            </span>
                            <span className="settings-status-pill-neutral shrink-0 px-1.5 py-0.5 text-[10px] font-medium">
                              {kindLabel(channel.kind, t)}
                            </span>
                            {channel.has_token ? (
                              <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                                <KeyRound className="h-3 w-3" />
                                {t('chatChannels.secretBadge')}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {channelSummary(channel, t)}
                          </div>
                        </button>

                        <Switch
                          className="settings-switch shrink-0"
                          checked={channel.enabled}
                          onCheckedChange={(checked: boolean) =>
                            void toggleEnabled(channel, checked)
                          }
                          aria-label={
                            channel.enabled
                              ? t('chatChannels.disableChannel')
                              : t('chatChannels.enableChannel')
                          }
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => void toggleLogs(channel.id)}
                          title={t('chatChannels.deliveryLogs')}
                          aria-label={t('chatChannels.deliveryLogs')}
                        >
                          <History className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => deleteChannel(channel)}
                          title={t('chatChannels.deleteChannel')}
                          aria-label={t('chatChannels.deleteChannel')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {logChannelId === channel.id ? (
                        <div className="mb-1 ml-2.5 space-y-1 border-l border-border pl-2.5">
                          {logs.length === 0 ? (
                            <p className="py-1 text-[11px] text-muted-foreground">
                              {t('chatChannels.noLogs')}
                            </p>
                          ) : (
                            logs.map((log) => (
                              <div
                                key={log.id}
                                className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"
                              >
                                <span className="truncate">
                                  {log.direction === 'inbound' ? '⬇' : '⬆'}{' '}
                                  {log.event ?? '—'}
                                </span>
                                <span
                                  className={
                                    log.status === 'failed' ||
                                    log.status === 'rejected'
                                      ? 'shrink-0 text-destructive'
                                      : 'shrink-0'
                                  }
                                >
                                  {log.status}
                                  {log.detail
                                    ? t('chatChannels.logDetail', {
                                        detail: log.detail,
                                      })
                                    : ''}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          icon={BellRing}
          title={t('chatChannels.eventsTitle')}
          description={t('chatChannels.eventsDescription')}
          action={
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => void saveEventFilter()}
              disabled={savingEvents}
            >
              {savingEvents ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 h-3.5 w-3.5" />
              )}
              {t('common:save')}
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {EVENT_OPTIONS.map((event) => {
                const checked = eventFilter.includes(event.value);
                return (
                  <button
                    key={event.value}
                    type="button"
                    onClick={() => toggleEvent(event.value, !checked)}
                    className="flex items-center gap-2 rounded-md border border-[var(--border-content)] px-2.5 py-2 text-left text-xs transition-colors hover:bg-[var(--surface-control-hover)]"
                  >
                    <Checkbox
                      checked={checked}
                      className="pointer-events-none"
                    />
                    <span>{t(event.labelKey)}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-4 pt-1">
              <div>
                <Label className="text-xs">
                  {t('chatChannels.includePromptLabel')}
                </Label>
                <p className="settings-row__description">
                  {t('chatChannels.includePromptDescription')}
                </p>
              </div>
              <Switch
                className="settings-switch"
                checked={includePromptText}
                onCheckedChange={(checked: boolean) =>
                  void togglePromptText(checked)
                }
              />
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={MessageSquare}
          title={t('chatChannels.commandTitle')}
          description={t('chatChannels.commandDescription')}
        >
          <div className="settings-row settings-row--stacked">
            <div>
              <Label htmlFor="chat-prefix" className="text-xs">
                {t('chatChannels.prefixLabel')}
              </Label>
              <p className="settings-row__description">
                {t('chatChannels.prefixHint')}
              </p>
            </div>
            <div className="flex max-w-sm gap-2">
              <Input
                id="chat-prefix"
                value={prefix}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="/vibex"
              />
              <Button
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={() => void savePrefix()}
                disabled={savingPrefix}
              >
                {savingPrefix ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                {t('common:save')}
              </Button>
            </div>
          </div>
        </SettingsSection>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogHeader>
          <DialogTitle>
            {editingChannel
              ? t('chatChannels.editChannel')
              : t('chatChannels.newChannel')}
          </DialogTitle>
          <DialogDescription>
            {t('chatChannels.dialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <DialogContent>
          <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="channel-name" className="text-xs">
                {t('chatChannels.nameLabel')}
              </Label>
              <Input
                id="channel-name"
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                placeholder={t('chatChannels.namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('chatChannels.typeLabel')}</Label>
              <Select
                value={draft.kind}
                onValueChange={(value) => updateDraft({ kind: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_KINDS.map((kind) => (
                    <SelectItem key={kind.value} value={kind.value}>
                      {kindLabel(kind.value, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Telegram */}
          {draft.kind === 'telegram' ? (
            <div className="space-y-1.5">
              <Label htmlFor="tg-chat" className="text-xs">
                Chat ID
              </Label>
              <Input
                id="tg-chat"
                value={draft.chat_id}
                onChange={(event) =>
                  updateDraft({ chat_id: event.target.value })
                }
                placeholder={t('chatChannels.telegramChatPlaceholder')}
              />
            </div>
          ) : null}

          {/* Feishu (app mode) */}
          {draft.kind === 'feishu' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="fs-app" className="text-xs">
                  App ID
                </Label>
                <Input
                  id="fs-app"
                  value={draft.app_id}
                  onChange={(event) =>
                    updateDraft({ app_id: event.target.value })
                  }
                  placeholder="cli_xxxxxxxx"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fs-chat" className="text-xs">
                  {t('chatChannels.feishuChatLabel')}
                </Label>
                <Input
                  id="fs-chat"
                  value={draft.chat_id}
                  onChange={(event) =>
                    updateDraft({ chat_id: event.target.value })
                  }
                  placeholder="oc_xxxxxxxx"
                />
              </div>
            </div>
          ) : null}

          {/* QQ (OneBot) */}
          {draft.kind === 'qq' ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="qq-url" className="text-xs">
                  {t('chatChannels.qqHttpLabel')}
                </Label>
                <Input
                  id="qq-url"
                  value={draft.base_url}
                  onChange={(event) =>
                    updateDraft({ base_url: event.target.value })
                  }
                  placeholder="http://127.0.0.1:3000"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qq-ws" className="text-xs">
                  {t('chatChannels.qqWsLabel')}
                </Label>
                <Input
                  id="qq-ws"
                  value={draft.ws_url}
                  onChange={(event) =>
                    updateDraft({ ws_url: event.target.value })
                  }
                  placeholder={t('chatChannels.qqWsPlaceholder')}
                />
              </div>
              <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('chatChannels.messageTypeLabel')}
                  </Label>
                  <Select
                    value={draft.message_type}
                    onValueChange={(value) =>
                      updateDraft({ message_type: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="group">
                        {t('chatChannels.messageTypeGroup')}
                      </SelectItem>
                      <SelectItem value="private">
                        {t('chatChannels.messageTypePrivate')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qq-target" className="text-xs">
                    {draft.message_type === 'private'
                      ? t('chatChannels.qqTargetPrivate')
                      : t('chatChannels.qqTargetGroup')}
                  </Label>
                  <Input
                    id="qq-target"
                    value={draft.target_id}
                    onChange={(event) =>
                      updateDraft({ target_id: event.target.value })
                    }
                    placeholder={t('chatChannels.qqTargetPlaceholder')}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* Generic webhook */}
          {draft.kind === 'webhook' ? (
            <div className="space-y-1.5">
              <Label htmlFor="wh-url" className="text-xs">
                Webhook URL
              </Label>
              <Input
                id="wh-url"
                value={draft.webhook_url}
                onChange={(event) =>
                  updateDraft({ webhook_url: event.target.value })
                }
                placeholder="https://example.com/webhook"
              />
            </div>
          ) : null}

          {/* Inbound allowlist (P0-0): only senders/chats listed here — plus the
              bound destination above — may drive agents remotely. */}
          {INBOUND_KINDS.has(draft.kind) ? (
            <div className="space-y-1.5">
              <Label htmlFor="channel-allowlist" className="text-xs">
                {t('chatChannels.allowlistLabel')}
                <span className="ml-1 text-muted-foreground">
                  {t('chatChannels.allowlistSafety')}
                </span>
              </Label>
              <Textarea
                id="channel-allowlist"
                value={draft.authorized_senders}
                onChange={(event) =>
                  updateDraft({ authorized_senders: event.target.value })
                }
                placeholder={t('chatChannels.allowlistPlaceholder')}
                rows={2}
              />
              <p className="text-[11px] text-muted-foreground">
                {t('chatChannels.allowlistHint')}
              </p>
            </div>
          ) : null}

          {/* Secret (per type) */}
          <div className="space-y-1.5">
            <Label htmlFor="channel-secret" className="text-xs">
              {secret.label}
              {secret.optional ? (
                <span className="ml-1 text-muted-foreground">
                  {t('chatChannels.optional')}
                </span>
              ) : null}
            </Label>
            <div className="flex gap-2">
              <Input
                id="channel-secret"
                type="password"
                value={draft.token}
                onChange={(event) => updateDraft({ token: event.target.value })}
                placeholder={
                  editingChannel?.has_token
                    ? t('chatChannels.secretSavedPlaceholder')
                    : secret.placeholder
                }
              />
              {editingChannel?.has_token ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  onClick={() => void removeToken()}
                >
                  {t('chatChannels.removeSecret')}
                </Button>
              ) : null}
            </div>
            {draft.kind === 'weixin' ? (
              <p className="text-[11px] text-muted-foreground">
                {t('chatChannels.weixinHint')}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="channel-enabled" className="text-xs">
                {t('chatChannels.enableLabel')}
              </Label>
              <p className="settings-row__description">
                {t('chatChannels.enableDescription')}
              </p>
            </div>
            <Switch
              id="channel-enabled"
              className="settings-switch"
              checked={draft.enabled}
              onCheckedChange={(checked: boolean) =>
                updateDraft({ enabled: checked })
              }
            />
          </div>

          {editingChannel ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full text-xs"
              onClick={() => void testChannel()}
              disabled={testing || !editingChannel.enabled}
            >
              {testing ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <SendHorizontal className="mr-1 h-3.5 w-3.5" />
              )}
              {t('chatChannels.testSend')}
            </Button>
          ) : null}
        </DialogContent>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setDialogOpen(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void saveChannel()}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1 h-3.5 w-3.5" />
            )}
            {editingChannel ? t('common:save') : t('common:create')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
