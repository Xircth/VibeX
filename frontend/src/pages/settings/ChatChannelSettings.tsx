import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRing,
  Bot,
  KeyRound,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Search,
  SendHorizontal,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  chatChannelApi,
  type ChatChannel,
  type ChatChannelPayload,
} from '@/lib/api';

import { SettingsPageHeader } from './settings-ui';

type DetailTab = 'channel' | 'events' | 'commands';

const CHANNEL_KINDS = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'feishu', label: '飞书机器人' },
  { value: 'dingtalk', label: '钉钉机器人' },
  { value: 'telegram', label: 'Telegram Bot' },
  { value: 'slack', label: 'Slack App' },
];

const EVENT_OPTIONS = [
  { value: 'prompt_started', label: '任务开始' },
  { value: 'prompt_finished', label: '任务结束' },
  { value: 'permission_requested', label: '权限请求' },
  { value: 'error', label: '运行错误' },
  { value: 'connection_status_changed', label: '连接状态' },
  { value: 'session_created', label: '会话创建' },
  { value: 'turn_completed', label: '回合完成' },
];

interface ChannelDraft {
  name: string;
  kind: string;
  enabled: boolean;
  webhook_url: string;
}

function emptyDraft(): ChannelDraft {
  return {
    name: '',
    kind: 'webhook',
    enabled: true,
    webhook_url: '',
  };
}

function draftFromChannel(channel: ChatChannel): ChannelDraft {
  return {
    name: channel.name,
    kind: channel.kind,
    enabled: channel.enabled,
    webhook_url: channel.webhook_url,
  };
}

function payloadFromDraft(draft: ChannelDraft): ChatChannelPayload {
  return {
    name: draft.name,
    kind: draft.kind,
    enabled: draft.enabled,
    webhook_url: draft.webhook_url,
  };
}

function sameDraft(a: ChannelDraft, b: ChannelDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatChannelSettings() {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<DetailTab>('channel');
  const [draft, setDraft] = useState<ChannelDraft>(() => emptyDraft());
  const [baseline, setBaseline] = useState<ChannelDraft>(() => emptyDraft());
  const [tokenDraft, setTokenDraft] = useState('');
  const [eventFilter, setEventFilter] = useState<string[]>([]);
  const [prefix, setPrefix] = useState('/vibex');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedId) ?? null,
    [channels, selectedId]
  );

  const dirty = useMemo(() => !sameDraft(draft, baseline), [baseline, draft]);

  const visibleChannels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return channels;
    return channels.filter(
      (channel) =>
        channel.name.toLowerCase().includes(query) ||
        channel.webhook_url.toLowerCase().includes(query)
    );
  }, [channels, search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [channelList, filter, commandPrefix] = await Promise.all([
        chatChannelApi.list(),
        chatChannelApi.getEventFilter(),
        chatChannelApi.getCommandPrefix(),
      ]);
      setChannels(channelList);
      setEventFilter(filter.enabled_events);
      setPrefix(commandPrefix.prefix);
      if (selectedId && !channelList.some((channel) => channel.id === selectedId)) {
        setSelectedId(null);
      }
    } catch (error) {
      toast.error('消息渠道加载失败', { description: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedChannel) return;
    const next = draftFromChannel(selectedChannel);
    setDraft(next);
    setBaseline(next);
    setTokenDraft('');
  }, [selectedChannel]);

  const startCreate = () => {
    const next = emptyDraft();
    setSelectedId(null);
    setDraft(next);
    setBaseline(next);
    setTokenDraft('');
    setTab('channel');
  };

  const saveChannel = async () => {
    setSaving(true);
    try {
      const payload = payloadFromDraft(draft);
      const channel = selectedChannel
        ? await chatChannelApi.update(selectedChannel.id, payload)
        : await chatChannelApi.create(payload);
      await refresh();
      setSelectedId(channel.id);
      const next = draftFromChannel(channel);
      setDraft(next);
      setBaseline(next);
      toast.success(selectedChannel ? '渠道已保存' : '渠道已创建');
    } catch (error) {
      toast.error('渠道保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteChannel = () => {
    if (!selectedChannel) return;
    const toastId = toast.warning(`删除 ${selectedChannel.name}？`, {
      duration: 8000,
      action: {
        label: '删除',
        onClick: async () => {
          toast.dismiss(toastId);
          try {
            await chatChannelApi.delete(selectedChannel.id);
            startCreate();
            await refresh();
            toast.success('渠道已删除');
          } catch (error) {
            toast.error('渠道删除失败', { description: errorMessage(error) });
          }
        },
      },
      cancel: {
        label: '取消',
        onClick: () => toast.dismiss(toastId),
      },
    });
  };

  const saveToken = async () => {
    if (!selectedChannel) return;
    setSaving(true);
    try {
      const updated = await chatChannelApi.saveToken(
        selectedChannel.id,
        tokenDraft
      );
      setChannels((previous) =>
        previous.map((channel) =>
          channel.id === updated.id ? updated : channel
        )
      );
      setTokenDraft('');
      toast.success('Token 已保存');
    } catch (error) {
      toast.error('Token 保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteToken = async () => {
    if (!selectedChannel) return;
    try {
      await chatChannelApi.deleteToken(selectedChannel.id);
      setChannels((previous) =>
        previous.map((channel) =>
          channel.id === selectedChannel.id
            ? { ...channel, has_token: false }
            : channel
        )
      );
      toast.success('Token 已移除');
    } catch (error) {
      toast.error('Token 移除失败', { description: errorMessage(error) });
    }
  };

  const testChannel = async () => {
    if (!selectedChannel) return;
    setTesting(true);
    try {
      const result = await chatChannelApi.test(selectedChannel.id);
      toast[result.ok ? 'success' : 'error'](result.message);
    } catch (error) {
      toast.error('测试发送失败', { description: errorMessage(error) });
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
    setSaving(true);
    try {
      const saved = await chatChannelApi.setEventFilter({
        enabled_events: eventFilter,
      });
      setEventFilter(saved.enabled_events);
      toast.success('事件过滤已保存');
    } catch (error) {
      toast.error('事件过滤保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const savePrefix = async () => {
    setSaving(true);
    try {
      const saved = await chatChannelApi.setCommandPrefix({ prefix });
      setPrefix(saved.prefix);
      toast.success('命令前缀已保存');
    } catch (error) {
      toast.error('命令前缀保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title="消息渠道"
        description="配置 IM 机器人，接收事件通知，并预留编码活动查询命令入口。"
      />

      <div className="grid min-h-[560px] grid-cols-[280px_minmax(0,1fr)] gap-4">
        <aside className="settings-card flex min-h-0 flex-col">
          <div className="settings-card__header">
            <div>
              <h3>渠道</h3>
              <p>{channels.length} 个本地配置</p>
            </div>
            <Button size="sm" className="h-8 text-xs" onClick={startCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              新建
            </Button>
          </div>

          <div className="border-b border-border/70 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索渠道"
                className="pl-8"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : visibleChannels.length === 0 ? (
              <div className="settings-empty-state">暂无消息渠道</div>
            ) : (
              visibleChannels.map((channel) => {
                const selected = channel.id === selectedId;
                return (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => setSelectedId(channel.id)}
                    className={`mb-1 w-full rounded-md px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'bg-primary/10 text-foreground'
                        : 'hover:bg-muted/70'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {channel.name}
                      </span>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                          channel.enabled
                            ? 'settings-status-success'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {channel.enabled ? '启用' : '停用'}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {channel.webhook_url}
                    </div>
                    {channel.has_token ? (
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                        <KeyRound className="h-3 w-3" />
                        Token 已保存
                      </div>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="settings-card min-w-0 overflow-hidden">
          <div className="settings-card__header">
            <div>
              <h3>{selectedChannel ? selectedChannel.name : '新建渠道'}</h3>
              <p>
                {selectedChannel
                  ? '配置机器人、事件和命令入口'
                  : '创建新的 IM 机器人渠道'}
              </p>
            </div>
            <div className="flex gap-2">
              {selectedChannel ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={deleteChannel}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              ) : null}
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={() => void saveChannel()}
                disabled={saving || (!dirty && !!selectedChannel)}
              >
                {saving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1 h-3.5 w-3.5" />
                )}
                保存
              </Button>
            </div>
          </div>

          <div className="border-b border-border/70 px-4 py-3">
            <div className="inline-flex rounded-md border border-border/70 p-0.5">
              {[
                ['channel', '渠道配置', Bot],
                ['events', '事件通知', BellRing],
                ['commands', '命令入口', MessageSquare],
              ].map(([value, label, Icon]) => (
                <button
                  key={value as string}
                  type="button"
                  onClick={() => setTab(value as DetailTab)}
                  className={`flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs ${
                    tab === value ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label as string}
                </button>
              ))}
            </div>
          </div>

          {tab === 'channel' ? (
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="channel-name" className="text-xs">
                    名称
                  </Label>
                  <Input
                    id="channel-name"
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        name: event.target.value,
                      }))
                    }
                    placeholder="编码活动通知"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">类型</Label>
                  <Select
                    value={draft.kind}
                    onValueChange={(value) =>
                      setDraft((previous) => ({ ...previous, kind: value }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHANNEL_KINDS.map((kind) => (
                        <SelectItem key={kind.value} value={kind.value}>
                          {kind.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="channel-webhook" className="text-xs">
                  Webhook URL
                </Label>
                <Input
                  id="channel-webhook"
                  value={draft.webhook_url}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      webhook_url: event.target.value,
                    }))
                  }
                  placeholder="https://example.com/webhook"
                />
              </div>

              <div className="settings-row">
                <div>
                  <Label htmlFor="channel-enabled" className="text-xs">
                    启用渠道
                  </Label>
                  <p className="settings-row__description">
                    停用后不会接收事件通知，也不会执行测试发送。
                  </p>
                </div>
                <Switch
                  id="channel-enabled"
                  className="settings-switch"
                  checked={draft.enabled}
                  onCheckedChange={(checked: boolean) =>
                    setDraft((previous) => ({ ...previous, enabled: checked }))
                  }
                />
              </div>

              {selectedChannel ? (
                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-end gap-2 border-t border-border/70 pt-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs">访问 Token</Label>
                    <Input
                      type="password"
                      value={tokenDraft}
                      onChange={(event) => setTokenDraft(event.target.value)}
                      placeholder={
                        selectedChannel.has_token
                          ? '已保存，输入新值可替换'
                          : '可选 token'
                      }
                    />
                  </div>
                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => void saveToken()}
                    disabled={!tokenDraft.trim() || saving}
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                    保存
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => void deleteToken()}
                    disabled={!selectedChannel.has_token}
                  >
                    移除
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => void testChannel()}
                    disabled={testing || !selectedChannel.enabled}
                  >
                    {testing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <SendHorizontal className="mr-1 h-3.5 w-3.5" />
                    )}
                    测试
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === 'events' ? (
            <div className="space-y-4 p-4">
              <div>
                <h4 className="text-sm font-semibold">事件过滤</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  只发送被选中的编码活动事件，避免高频消息打扰。
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {EVENT_OPTIONS.map((event) => {
                  const checked = eventFilter.includes(event.value);
                  return (
                    <button
                      key={event.value}
                      type="button"
                      onClick={() => toggleEvent(event.value, !checked)}
                      className="flex items-center gap-2 rounded-md border border-border/70 px-2.5 py-2 text-left text-xs hover:bg-muted/70"
                    >
                      <Checkbox checked={checked} className="pointer-events-none" />
                      <span>{event.label}</span>
                    </button>
                  );
                })}
              </div>
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={() => void saveEventFilter()}
                disabled={saving}
              >
                <Save className="mr-1 h-3.5 w-3.5" />
                保存事件过滤
              </Button>
            </div>
          ) : null}

          {tab === 'commands' ? (
            <div className="space-y-4 p-4">
              <div>
                <h4 className="text-sm font-semibold">查询命令</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  IM 机器人查询编码活动时使用此前缀，后续命令处理会复用该配置。
                </p>
              </div>
              <div className="max-w-sm space-y-1.5">
                <Label htmlFor="chat-prefix" className="text-xs">
                  命令前缀
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
                className="h-8 text-xs"
                onClick={() => void savePrefix()}
                disabled={saving}
              >
                <Save className="mr-1 h-3.5 w-3.5" />
                保存命令前缀
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
