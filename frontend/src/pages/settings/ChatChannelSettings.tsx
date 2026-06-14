import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRing,
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
import {
  chatChannelApi,
  type ChatChannel,
  type ChatChannelPayload,
} from '@/lib/api';

import { SettingsPageHeader, SettingsSection } from './settings-ui';

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

function kindLabel(kind: string): string {
  return CHANNEL_KINDS.find((item) => item.value === kind)?.label ?? kind;
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatChannelSettings() {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  // Create / edit dialog state.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<ChatChannel | null>(null);
  const [draft, setDraft] = useState<ChannelDraft>(() => emptyDraft());
  const [tokenDraft, setTokenDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // App-level notification settings.
  const [eventFilter, setEventFilter] = useState<string[]>([]);
  const [prefix, setPrefix] = useState('/vibex');
  const [savingEvents, setSavingEvents] = useState(false);
  const [savingPrefix, setSavingPrefix] = useState(false);

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
    } catch (error) {
      toast.error('消息渠道加载失败', { description: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCreate = () => {
    setEditingChannel(null);
    setDraft(emptyDraft());
    setTokenDraft('');
    setDialogOpen(true);
  };

  const openEdit = (channel: ChatChannel) => {
    setEditingChannel(channel);
    setDraft(draftFromChannel(channel));
    setTokenDraft('');
    setDialogOpen(true);
  };

  const saveChannel = async () => {
    if (!draft.name.trim()) {
      toast.error('请填写渠道名称');
      return;
    }
    setSaving(true);
    try {
      const payload = payloadFromDraft(draft);
      const channel = editingChannel
        ? await chatChannelApi.update(editingChannel.id, payload)
        : await chatChannelApi.create(payload);
      await refresh();
      toast.success(editingChannel ? '渠道已保存' : '渠道已创建');
      if (editingChannel) {
        setEditingChannel(channel);
        setDraft(draftFromChannel(channel));
      } else {
        setDialogOpen(false);
      }
    } catch (error) {
      toast.error('渠道保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (channel: ChatChannel, enabled: boolean) => {
    // Optimistic toggle persisted immediately.
    setChannels((previous) =>
      previous.map((item) =>
        item.id === channel.id ? { ...item, enabled } : item
      )
    );
    try {
      await chatChannelApi.update(channel.id, {
        ...payloadFromDraft(draftFromChannel(channel)),
        enabled,
      });
    } catch (error) {
      setChannels((previous) =>
        previous.map((item) =>
          item.id === channel.id ? { ...item, enabled: !enabled } : item
        )
      );
      toast.error('渠道状态更新失败', { description: errorMessage(error) });
    }
  };

  const deleteChannel = (channel: ChatChannel) => {
    const toastId = toast.warning(`删除 ${channel.name}？`, {
      duration: 8000,
      action: {
        label: '删除',
        onClick: async () => {
          toast.dismiss(toastId);
          try {
            await chatChannelApi.delete(channel.id);
            if (editingChannel?.id === channel.id) {
              setDialogOpen(false);
            }
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
    if (!editingChannel) return;
    setSaving(true);
    try {
      const updated = await chatChannelApi.saveToken(
        editingChannel.id,
        tokenDraft
      );
      setChannels((previous) =>
        previous.map((channel) =>
          channel.id === updated.id ? updated : channel
        )
      );
      setEditingChannel(updated);
      setTokenDraft('');
      toast.success('Token 已保存');
    } catch (error) {
      toast.error('Token 保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteToken = async () => {
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
      toast.success('Token 已移除');
    } catch (error) {
      toast.error('Token 移除失败', { description: errorMessage(error) });
    }
  };

  const testChannel = async () => {
    if (!editingChannel) return;
    setTesting(true);
    try {
      const result = await chatChannelApi.test(editingChannel.id);
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
    setSavingEvents(true);
    try {
      const saved = await chatChannelApi.setEventFilter({
        enabled_events: eventFilter,
      });
      setEventFilter(saved.enabled_events);
      toast.success('事件过滤已保存');
    } catch (error) {
      toast.error('事件过滤保存失败', { description: errorMessage(error) });
    } finally {
      setSavingEvents(false);
    }
  };

  const savePrefix = async () => {
    setSavingPrefix(true);
    try {
      const saved = await chatChannelApi.setCommandPrefix({ prefix });
      setPrefix(saved.prefix);
      toast.success('命令前缀已保存');
    } catch (error) {
      toast.error('命令前缀保存失败', { description: errorMessage(error) });
    } finally {
      setSavingPrefix(false);
    }
  };

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title="消息渠道"
        description="配置 IM 机器人，接收事件通知，并预留编码活动查询命令入口。"
      />

      <div className="settings-sections">
        <SettingsSection
          icon={SendHorizontal}
          title="渠道"
          description={`${channels.length} 个本地配置的 IM 机器人渠道。`}
          action={
            <Button size="sm" className="h-8 text-xs" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              新建渠道
            </Button>
          }
        >
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <SendHorizontal className="h-8 w-8 text-muted-foreground/60" />
              <div>
                <p className="text-sm font-medium">还没有消息渠道</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  新建渠道后即可接收编码活动通知。
                </p>
              </div>
              <Button size="sm" className="h-8 text-xs" onClick={openCreate}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                新建渠道
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {channels.length > 4 ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索渠道"
                    className="pl-8"
                  />
                </div>
              ) : null}

              <div className="space-y-1">
                {visibleChannels.length === 0 ? (
                  <div className="settings-empty-state py-4 text-center">
                    没有匹配的渠道
                  </div>
                ) : (
                  visibleChannels.map((channel) => (
                    <div
                      key={channel.id}
                      className="group flex items-center gap-3 rounded-md px-2.5 py-2 transition-colors hover:bg-[var(--surface-control-hover)]"
                    >
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
                            {kindLabel(channel.kind)}
                          </span>
                          {channel.has_token ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                              <KeyRound className="h-3 w-3" />
                              Token
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {channel.webhook_url || '未配置 Webhook'}
                        </div>
                      </button>

                      <Switch
                        className="settings-switch shrink-0"
                        checked={channel.enabled}
                        onCheckedChange={(checked: boolean) =>
                          void toggleEnabled(channel, checked)
                        }
                        aria-label={channel.enabled ? '停用渠道' : '启用渠道'}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => deleteChannel(channel)}
                        title="删除渠道"
                        aria-label="删除渠道"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          icon={BellRing}
          title="事件通知"
          description="只发送被选中的编码活动事件，避免高频消息打扰。"
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
              保存
            </Button>
          }
        >
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
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span>{event.label}</span>
                </button>
              );
            })}
          </div>
        </SettingsSection>

        <SettingsSection
          icon={MessageSquare}
          title="命令入口"
          description="IM 机器人查询编码活动时使用此前缀，后续命令处理会复用该配置。"
        >
          <div className="settings-row settings-row--stacked">
            <div>
              <Label htmlFor="chat-prefix" className="text-xs">
                命令前缀
              </Label>
              <p className="settings-row__description">
                例如 /vibex status 将触发状态查询。
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
                保存
              </Button>
            </div>
          </div>
        </SettingsSection>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogHeader>
          <DialogTitle>{editingChannel ? '编辑渠道' : '新建渠道'}</DialogTitle>
          <DialogDescription>
            {editingChannel
              ? '更新机器人配置，并管理访问 Token 与测试发送。'
              : '创建新的 IM 机器人渠道，用于接收编码活动通知。'}
          </DialogDescription>
        </DialogHeader>

        <DialogContent>
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

          <div className="flex items-center justify-between gap-4">
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

          {editingChannel ? (
            <div className="space-y-3 rounded-lg border border-[var(--border-content)] bg-[var(--surface-control)] p-3">
              <div className="space-y-1.5">
                <Label className="text-xs">访问 Token</Label>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={tokenDraft}
                    onChange={(event) => setTokenDraft(event.target.value)}
                    placeholder={
                      editingChannel.has_token
                        ? '已保存，输入新值可替换'
                        : '可选 token'
                    }
                  />
                  <Button
                    size="sm"
                    className="h-8 shrink-0 text-xs"
                    onClick={() => void saveToken()}
                    disabled={!tokenDraft.trim() || saving}
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                    保存
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 text-xs"
                    onClick={() => void deleteToken()}
                    disabled={!editingChannel.has_token}
                  >
                    移除
                  </Button>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => void testChannel()}
                disabled={testing || !editingChannel.enabled}
              >
                {testing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SendHorizontal className="mr-1 h-3.5 w-3.5" />
                )}
                测试发送
              </Button>
            </div>
          ) : null}
        </DialogContent>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setDialogOpen(false)}
          >
            取消
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
            {editingChannel ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
