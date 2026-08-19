import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  History,
  KeyRound,
  Loader2,
  Plus,
  Save,
  Search,
  SendHorizontal,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';

import { Button } from '@/components/ui/button';
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

type Translate = (key: string, options?: Record<string, unknown>) => string;

type ChatChannelTab = 'channels' | 'commands' | 'events';

const TABS: Array<{
  value: ChatChannelTab;
  labelKey:
    | 'chatChannels.tabChannels'
    | 'chatChannels.tabCommands'
    | 'chatChannels.tabEvents';
}> = [
  { value: 'channels', labelKey: 'chatChannels.tabChannels' },
  { value: 'commands', labelKey: 'chatChannels.tabCommands' },
  { value: 'events', labelKey: 'chatChannels.tabEvents' },
];

const CHANNEL_KINDS = [
  { value: 'telegram' },
  { value: 'feishu' },
  { value: 'weixin' },
  { value: 'qq' },
  { value: 'webhook' },
];

const EVENT_OPTIONS = [
  {
    value: 'prompt_started',
    labelKey: 'chatChannels.events.promptStarted',
    descriptionKey: 'chatChannels.events.promptStartedDescription',
  },
  {
    value: 'prompt_finished',
    labelKey: 'chatChannels.events.promptFinished',
    descriptionKey: 'chatChannels.events.promptFinishedDescription',
  },
  {
    value: 'permission_requested',
    labelKey: 'chatChannels.events.permissionRequested',
    descriptionKey: 'chatChannels.events.permissionRequestedDescription',
  },
  {
    value: 'error',
    labelKey: 'chatChannels.events.error',
    descriptionKey: 'chatChannels.events.errorDescription',
  },
  {
    value: 'connection_status_changed',
    labelKey: 'chatChannels.events.connectionStatusChanged',
    descriptionKey: 'chatChannels.events.connectionStatusChangedDescription',
  },
  {
    value: 'session_created',
    labelKey: 'chatChannels.events.sessionCreated',
    descriptionKey: 'chatChannels.events.sessionCreatedDescription',
  },
  {
    value: 'turn_completed',
    labelKey: 'chatChannels.events.turnCompleted',
    descriptionKey: 'chatChannels.events.turnCompletedDescription',
  },
] as const;

const COMMAND_CATALOG = [
  { usage: 'folder [n|name]', descriptionKey: 'chatChannels.commands.folder' },
  { usage: 'agent [n|id]', descriptionKey: 'chatChannels.commands.agent' },
  { usage: 'task <text>', descriptionKey: 'chatChannels.commands.task' },
  { usage: 'sessions', descriptionKey: 'chatChannels.commands.sessions' },
  { usage: 'resume [n|id]', descriptionKey: 'chatChannels.commands.resume' },
  { usage: 'cancel', descriptionKey: 'chatChannels.commands.cancel' },
  {
    usage: 'approve [always]',
    descriptionKey: 'chatChannels.commands.approve',
  },
  { usage: 'deny', descriptionKey: 'chatChannels.commands.deny' },
  {
    usage: 'search <keyword>',
    descriptionKey: 'chatChannels.commands.search',
  },
  { usage: 'today', descriptionKey: 'chatChannels.commands.today' },
  { usage: 'status', descriptionKey: 'chatChannels.commands.status' },
  { usage: 'help', descriptionKey: 'chatChannels.commands.help' },
] as const;

const WEBHOOK_PAYLOAD_EXAMPLES = [
  {
    event: 'prompt_started',
    labelKey: 'chatChannels.events.promptStarted',
    value: `{
  "event": "prompt_started",
  "body": "🚀 Turn started\\nThe agent started a turn.",
  "source": "vibex"
}`,
  },
  {
    event: 'prompt_finished',
    labelKey: 'chatChannels.events.promptFinished',
    value: `{
  "event": "prompt_finished",
  "body": "✅ Turn complete\\nThe agent finished this turn.",
  "source": "vibex"
}`,
  },
  {
    event: 'permission_requested',
    labelKey: 'chatChannels.events.permissionRequested',
    value: `{
  "event": "permission_requested",
  "body": "🔐 Permission request\\nThe agent is waiting for approval.",
  "source": "vibex"
}`,
  },
  {
    event: 'error',
    labelKey: 'chatChannels.events.error',
    value: `{
  "event": "error",
  "body": "❌ Agent error\\nThe agent reported an error.",
  "source": "vibex"
}`,
  },
] as const;

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
  topic_mode: boolean;
  daily_report_enabled: boolean;
  daily_report_time: string;
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
    topic_mode: false,
    daily_report_enabled: false,
    daily_report_time: '18:00',
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
    topic_mode: c.topic_mode === true,
    daily_report_enabled: c.daily_report_enabled === true,
    daily_report_time: cfgStr(c, 'daily_report_time') || '18:00',
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
      return {
        chat_id: draft.chat_id.trim(),
        topic_mode: draft.topic_mode,
        daily_report_enabled: draft.daily_report_enabled,
        daily_report_time: draft.daily_report_time,
        authorized_senders: senders,
      };
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
  const [tab, setTab] = useState<ChatChannelTab>('channels');

  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<ChatChannel | null>(
    null
  );
  const [draft, setDraft] = useState<ChannelDraft>(() => emptyDraft());
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
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

  const [eventFilter, setEventFilter] = useState<string[]>([]);
  const [savedEventFilter, setSavedEventFilter] = useState<string[]>([]);
  const [prefix, setPrefix] = useState('/vibex');
  const [savedPrefix, setSavedPrefix] = useState('/vibex');
  const [includePromptText, setIncludePromptText] = useState(false);
  const [savingPrefix, setSavingPrefix] = useState(false);
  const [webhooks, setWebhooks] = useState<
    Array<{ url: string; enabled: boolean }>
  >([]);
  const [webhookDraft, setWebhookDraft] = useState('');
  const [messageLanguage, setMessageLanguage] = useState('en');
  const [weixinQrOpen, setWeixinQrOpen] = useState(false);
  const [weixinQrImage, setWeixinQrImage] = useState<string | null>(null);
  const [weixinQrId, setWeixinQrId] = useState<string | null>(null);
  const [weixinQrStatus, setWeixinQrStatus] = useState('idle');

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
      const [
        channelList,
        channelStatuses,
        filter,
        commandPrefix,
        promptText,
        hooks,
        language,
      ] = await Promise.all([
        chatChannelApi.list(),
        chatChannelApi.statuses().catch(() => []),
        chatChannelApi.getEventFilter(),
        chatChannelApi.getCommandPrefix(),
        chatChannelApi.getIncludePromptText(),
        chatChannelApi.getWebhooks().catch(() => []),
        chatChannelApi.getLanguage().catch(() => 'en'),
      ]);
      setChannels(channelList);
      setStatuses(
        Object.fromEntries(
          channelStatuses.map((item) => [item.channel_id, item.status])
        )
      );
      setEventFilter(filter.enabled_events);
      setSavedEventFilter(filter.enabled_events);
      setPrefix(commandPrefix.prefix);
      setSavedPrefix(commandPrefix.prefix);
      setIncludePromptText(promptText);
      setWebhooks(hooks);
      setMessageLanguage(language);
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
    if (
      !weixinQrOpen ||
      !weixinQrId ||
      !editingChannel ||
      weixinQrStatus !== 'waiting'
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void chatChannelApi
        .weixinCheckQrcode(editingChannel.id, weixinQrId)
        .then((result) => {
          if (result.status === 'confirmed') {
            setWeixinQrStatus('confirmed');
            setWeixinQrOpen(false);
            void refresh();
          } else if (result.status === 'expired') {
            setWeixinQrStatus('expired');
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [editingChannel, refresh, weixinQrId, weixinQrOpen, weixinQrStatus]);

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

  const persistEventFilter = async (next: string[]) => {
    const previous = eventFilter;
    setEventFilter(next);
    try {
      const saved = await chatChannelApi.setEventFilter({
        enabled_events: next,
      });
      setEventFilter(saved.enabled_events);
      setSavedEventFilter(saved.enabled_events);
    } catch (error) {
      setEventFilter(previous);
      toast.error(t('chatChannels.eventFilterSaveFailed'), {
        description: errorMessage(error),
      });
    }
  };

  const toggleEvent = (eventName: string, checked: boolean) => {
    const next = checked
      ? [...new Set([...eventFilter, eventName])]
      : eventFilter.filter((item) => item !== eventName);
    void persistEventFilter(next);
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

  const persistWebhooks = async (
    next: Array<{ url: string; enabled: boolean }>
  ) => {
    const previous = webhooks;
    setWebhooks(next);
    try {
      const saved = await chatChannelApi.setWebhooks(next);
      setWebhooks(saved);
    } catch (error) {
      setWebhooks(previous);
      toast.error(t('chatChannels.settingSaveFailed'), {
        description: errorMessage(error),
      });
    }
  };

  const addWebhook = () => {
    const url = webhookDraft.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      toast.error(t('chatChannels.webhookUrlInvalid'));
      return;
    }
    setWebhookDraft('');
    void persistWebhooks([...webhooks, { url, enabled: true }]);
  };

  const updateDraft = (patch: Partial<ChannelDraft>) =>
    setDraft((previous) => ({ ...previous, ...patch }));

  const focusTab = (next: ChatChannelTab) => {
    setTab(next);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(`[data-chat-channel-tab="${next}"]`)
        ?.focus();
    });
  };

  return (
    <div className="settings-content">
      <div className="chat-channel-heading">
        <div className="chat-channel-heading__copy">
          <h2>
            <SendHorizontal aria-hidden="true" />
            <span>{t('chatChannels.title')}</span>
          </h2>
          <p>{t('chatChannels.description')}</p>
        </div>
        <div className="chat-channel-heading__actions">
          <div
            className="chat-channel-tabs"
            role="tablist"
            aria-label={t('chatChannels.tabsAria')}
            onKeyDown={(event) => {
              const index = TABS.findIndex((item) => item.value === tab);
              let next = index;
              if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
              else if (event.key === 'ArrowLeft') {
                next = (index - 1 + TABS.length) % TABS.length;
              } else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = TABS.length - 1;
              else return;
              event.preventDefault();
              focusTab(TABS[next].value);
            }}
          >
            {TABS.map((item) => {
              const active = tab === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  data-chat-channel-tab={item.value}
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className={active ? 'is-active' : undefined}
                  onClick={() => setTab(item.value)}
                >
                  {t(item.labelKey)}
                </button>
              );
            })}
          </div>
          {tab === 'channels' && channels.length > 0 ? (
            <Button size="sm" className="h-8 text-xs" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('chatChannels.newChannel')}
            </Button>
          ) : null}
        </div>
      </div>

      {tab === 'channels' ? (
        <div
          role="tabpanel"
          className="settings-card overflow-hidden rounded-lg border"
        >
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <div className="chat-channel-empty">
              <SendHorizontal className="h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm font-medium">
                {t('chatChannels.emptyTitle')}
              </p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {t('chatChannels.emptyHint')}
              </p>
              <Button
                size="sm"
                className="mt-2 h-8 text-xs"
                onClick={openCreate}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t('chatChannels.newChannel')}
              </Button>
            </div>
          ) : (
            <div className="space-y-2 p-3">
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
                            <span
                              className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                                statuses[channel.id] === 'connected'
                                  ? 'bg-green-500'
                                  : statuses[channel.id] === 'connecting'
                                    ? 'bg-yellow-500'
                                    : statuses[channel.id] === 'error'
                                      ? 'bg-red-500'
                                      : 'bg-muted-foreground/40'
                              }`}
                              title={statuses[channel.id] ?? 'disconnected'}
                            />
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
        </div>
      ) : null}

      {tab === 'commands' ? (
        <div role="tabpanel" className="space-y-3">
          <div className="settings-card overflow-hidden rounded-lg border">
            <div className="flex items-end justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="chat-prefix" className="text-sm">
                  {t('chatChannels.prefixLabel')}
                </Label>
                <Input
                  id="chat-prefix"
                  value={prefix}
                  onChange={(event) => setPrefix(event.target.value)}
                  placeholder="/vibex"
                />
              </div>
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
            <div className="flex items-center justify-between gap-4 border-t border-[var(--border-subtle)] px-4 py-3">
              <Label className="text-sm">
                {t('chatChannels.messageLanguage')}
              </Label>
              <Select
                value={messageLanguage}
                onValueChange={(value) => {
                  setMessageLanguage(value);
                  void chatChannelApi.setLanguage(value);
                }}
              >
                <SelectTrigger className="h-8 w-36 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="zh-CN">简体中文</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="settings-card overflow-hidden rounded-lg border">
            {COMMAND_CATALOG.map((command) => (
              <div key={command.usage} className="chat-channel-command">
                <div className="min-w-0">
                  <code className="chat-channel-command-usage">
                    {prefix.endsWith('/') ? prefix : `${prefix || '/'} `}
                    {command.usage}
                  </code>
                  <p className="chat-channel-command-copy">
                    {t(command.descriptionKey)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {tab === 'events' ? (
        <div role="tabpanel" className="space-y-3">
          <div className="settings-card overflow-hidden rounded-lg border">
            {EVENT_OPTIONS.map((event) => {
              const checked = eventFilter.includes(event.value);
              return (
                <div key={event.value} className="chat-channel-event">
                  <div className="min-w-0">
                    <Label
                      htmlFor={`chat-event-${event.value}`}
                      className="cursor-pointer text-sm font-medium"
                    >
                      {t(event.labelKey)}
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(event.descriptionKey)}
                    </p>
                  </div>
                  <Switch
                    id={`chat-event-${event.value}`}
                    className="settings-switch shrink-0"
                    checked={checked}
                    onCheckedChange={(value: boolean) =>
                      toggleEvent(event.value, value)
                    }
                    aria-label={t(event.labelKey)}
                  />
                </div>
              );
            })}
            <div className="chat-channel-event border-t border-[var(--border-subtle)]">
              <div className="min-w-0">
                <Label
                  htmlFor="chat-include-prompt"
                  className="cursor-pointer text-sm font-medium"
                >
                  {t('chatChannels.includePromptLabel')}
                </Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('chatChannels.includePromptDescription')}
                </p>
              </div>
              <Switch
                id="chat-include-prompt"
                className="settings-switch shrink-0"
                checked={includePromptText}
                onCheckedChange={(checked: boolean) =>
                  void togglePromptText(checked)
                }
                aria-label={t('chatChannels.includePromptLabel')}
              />
            </div>
          </div>

          <div className="settings-card overflow-hidden rounded-lg border">
            <div className="px-4 py-3">
              <h3 className="text-sm font-semibold">
                {t('chatChannels.webhooksTitle')}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('chatChannels.webhooksDescription')}
              </p>
            </div>
            {webhooks.map((hook, index) => (
              <div
                key={`${hook.url}-${index}`}
                className="chat-channel-webhook"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Switch
                    className="settings-switch"
                    checked={hook.enabled}
                    onCheckedChange={(checked: boolean) => {
                      void persistWebhooks(
                        webhooks.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, enabled: checked }
                            : item
                        )
                      );
                    }}
                    aria-label={hook.url}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {hook.url}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => {
                    void persistWebhooks(
                      webhooks.filter((_, itemIndex) => itemIndex !== index)
                    );
                  }}
                >
                  {t('common:delete')}
                </Button>
              </div>
            ))}
            <div className="flex gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
              <Input
                value={webhookDraft}
                onChange={(event) => setWebhookDraft(event.target.value)}
                placeholder="https://example.com/hooks/vibex"
              />
              <Button
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={addWebhook}
              >
                {t('chatChannels.addWebhook')}
              </Button>
            </div>
            <div className="px-4 pb-2 pt-3">
              <p className="text-sm font-medium">
                {t('chatChannels.webhookPayloadTitle')}
              </p>
            </div>
            <div className="chat-channel-payload-list">
              {WEBHOOK_PAYLOAD_EXAMPLES.map((example) => (
                <figure
                  key={example.event}
                  className="chat-channel-payload-card"
                >
                  <figcaption>{t(example.labelKey)}</figcaption>
                  <pre>
                    <code>{example.value}</code>
                  </pre>
                </figure>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <Dialog
        open={weixinQrOpen}
        onOpenChange={setWeixinQrOpen}
        role="dialog"
        aria-modal="true"
        aria-labelledby="weixin-qr-title"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle id="weixin-qr-title">
              {t('chatChannels.weixinScanTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            {weixinQrImage ? (
              <img src={weixinQrImage} width={220} height={220} alt="" />
            ) : (
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            )}
            <p className="text-xs text-muted-foreground">{weixinQrStatus}</p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-channel-dialog-title"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle id="chat-channel-dialog-title">
              {editingChannel
                ? t('chatChannels.editChannel')
                : t('chatChannels.newChannel')}
            </DialogTitle>
            <DialogDescription>
              {t('chatChannels.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

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
              <div className="flex items-center justify-between pt-1">
                <Label className="text-xs">
                  {t('chatChannels.topicModeLabel')}
                </Label>
                <Switch
                  className="settings-switch"
                  checked={draft.topic_mode}
                  onCheckedChange={(checked: boolean) =>
                    updateDraft({ topic_mode: checked })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  {t('chatChannels.dailyReportLabel')}
                </Label>
                <Switch
                  className="settings-switch"
                  checked={draft.daily_report_enabled}
                  onCheckedChange={(checked: boolean) =>
                    updateDraft({ daily_report_enabled: checked })
                  }
                />
              </div>
              {draft.daily_report_enabled ? (
                <Input
                  type="time"
                  value={draft.daily_report_time}
                  onChange={(event) =>
                    updateDraft({ daily_report_time: event.target.value })
                  }
                />
              ) : null}
            </div>
          ) : null}

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
            {draft.kind === 'weixin' && editingChannel ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setWeixinQrOpen(true);
                  void (async () => {
                    setWeixinQrStatus('loading');
                    try {
                      const qr = await chatChannelApi.weixinGetQrcode();
                      setWeixinQrId(qr.qrcode_id);
                      if (qr.qrcode_img_content.startsWith('data:')) {
                        setWeixinQrImage(qr.qrcode_img_content);
                      } else {
                        const QRCode = (await import('qrcode')).default;
                        setWeixinQrImage(
                          await QRCode.toDataURL(
                            qr.qrcode_url ||
                              qr.qrcode_img_content ||
                              qr.qrcode_id,
                            { margin: 1, width: 220 }
                          )
                        );
                      }
                      setWeixinQrStatus('waiting');
                    } catch {
                      setWeixinQrStatus('error');
                    }
                  })();
                }}
              >
                {t('chatChannels.weixinScan')}
              </Button>
            ) : null}
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
        </DialogContent>
      </Dialog>
    </div>
  );
}
