import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Shield,
  Square,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  type PortProbeResult,
  type WebServerStatus,
  type WebServiceConfig,
  webServiceApi,
} from '@/lib/api';

import {
  SettingsActionBar,
  SettingsPageHeader,
  SettingsSection,
} from './SettingsUi';

const DEFAULT_CONFIG: WebServiceConfig = {
  port: 17891,
  token: null,
  auto_start: false,
};

function sameConfig(a: WebServiceConfig, b: WebServiceConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function statusLabel(status: WebServerStatus | null): string {
  if (!status) {
    return '未检查';
  }
  return status.running ? '运行中' : '已停止';
}

export function WebServiceSettings() {
  const [config, setConfig] = useState<WebServiceConfig>(DEFAULT_CONFIG);
  const [draft, setDraft] = useState<WebServiceConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<WebServerStatus | null>(null);
  const [probe, setProbe] = useState<PortProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [probing, setProbing] = useState(false);

  const dirty = useMemo(() => !sameConfig(config, draft), [config, draft]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [savedConfig, currentStatus] = await Promise.all([
        webServiceApi.getConfig(),
        webServiceApi.getStatus(),
      ]);
      setConfig(savedConfig);
      setDraft(savedConfig);
      setStatus(currentStatus);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Web 服务配置读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshStatus = useCallback(async () => {
    setStatusBusy(true);
    try {
      setStatus(await webServiceApi.getStatus());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Web 服务状态读取失败');
    } finally {
      setStatusBusy(false);
    }
  }, []);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    try {
      const saved = await webServiceApi.updateConfig(draft);
      setConfig(saved);
      setDraft(saved);
      setProbe(null);
      toast.success('Web 服务配置已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Web 服务配置保存失败');
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const discard = useCallback(() => {
    setDraft(config);
    setProbe(null);
  }, [config]);

  const startServer = useCallback(async () => {
    if (dirty) {
      toast.error('请先保存 Web 服务配置');
      return;
    }

    setStatusBusy(true);
    try {
      setStatus(await webServiceApi.start());
      toast.success('Web 服务已启动');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Web 服务启动失败');
    } finally {
      setStatusBusy(false);
    }
  }, [dirty]);

  const stopServer = useCallback(async () => {
    setStatusBusy(true);
    try {
      setStatus(await webServiceApi.stop());
      toast.success('Web 服务已停止');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Web 服务停止失败');
    } finally {
      setStatusBusy(false);
    }
  }, []);

  const probePort = useCallback(async () => {
    setProbing(true);
    try {
      const result = await webServiceApi.probePort(draft.port);
      setProbe(result);
      toast[result.available ? 'success' : 'error'](
        result.available ? '端口可用' : (result.message ?? '端口不可用')
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '端口探测失败');
    } finally {
      setProbing(false);
    }
  }, [draft.port]);

  const generateToken = useCallback(async () => {
    setSaving(true);
    try {
      const saved = await webServiceApi.generateToken();
      setConfig(saved);
      setDraft(saved);
      toast.success('访问 token 已生成');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Token 生成失败');
    } finally {
      setSaving(false);
    }
  }, []);

  const copyText = useCallback(async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} 已复制`);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title="Web 服务"
        description="管理本机 Web 服务监听、访问控制和启动状态。"
      />

      <div className="settings-sections">
        <SettingsSection
          icon={Globe}
          title="服务状态"
          description="Web 服务仅监听本机回环地址，用于本地集成和自动化访问。"
        >
          <div className="settings-row">
            <div>
              <Label className="text-xs">当前状态</Label>
              <p className="settings-row__description">
                {status?.address ?? '服务未启动'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-1 text-xs font-medium ${
                  status?.running
                    ? 'settings-status-success'
                    : 'text-muted-foreground'
                }`}
              >
                {statusLabel(status)}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => void refreshStatus()}
                disabled={statusBusy}
                title="刷新状态"
                aria-label="刷新状态"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${statusBusy ? 'animate-spin' : ''}`}
                />
              </Button>
            </div>
          </div>

          <div className="settings-row">
            <div>
              <Label className="text-xs">服务控制</Label>
              <p className="settings-row__description">
                配置变更需要保存后再启动服务。
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {status?.address ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => window.open(status.address!, '_blank')}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  打开
                </Button>
              ) : null}
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={() =>
                  status?.running ? void stopServer() : void startServer()
                }
                disabled={statusBusy}
              >
                {statusBusy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : status?.running ? (
                  <Square className="mr-1 h-3.5 w-3.5" />
                ) : (
                  <Play className="mr-1 h-3.5 w-3.5" />
                )}
                {status?.running ? '停止' : '启动'}
              </Button>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          icon={Shield}
          title="访问配置"
          description="端口和 token 会保存到本机配置；token 只用于后续受保护接口。"
        >
          <div className="settings-row">
            <div>
              <Label htmlFor="web-service-port" className="text-xs">
                监听端口
              </Label>
              <p className="settings-row__description">
                默认端口为 17891，建议仅使用本机回环访问。
              </p>
            </div>
            <div className="flex w-full max-w-xs gap-2">
              <Input
                id="web-service-port"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    port: Number(event.target.value),
                  }))
                }
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={() => void probePort()}
                disabled={probing}
              >
                {probing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                探测
              </Button>
            </div>
          </div>

          {probe ? (
            <div className="px-4 pb-3 text-[11px] text-muted-foreground">
              端口 {probe.port}：{probe.available ? '可用' : probe.message}
            </div>
          ) : null}

          <div className="settings-row">
            <div>
              <Label htmlFor="web-service-autostart" className="text-xs">
                自动启动
              </Label>
              <p className="settings-row__description">
                应用启动时自动启动 Web 服务。
              </p>
            </div>
            <Switch
              id="web-service-autostart"
              className="settings-switch"
              checked={draft.auto_start}
              onCheckedChange={(checked: boolean) =>
                setDraft((previous) => ({
                  ...previous,
                  auto_start: checked,
                }))
              }
            />
          </div>

          <div className="settings-row">
            <div>
              <Label className="text-xs">访问 Token</Label>
              <p className="settings-row__description">
                Token 会被遮罩显示，可重新生成或复制。
              </p>
            </div>
            <div className="flex w-full max-w-sm gap-2">
              <Input
                type="password"
                readOnly
                value={draft.token ?? ''}
                placeholder="尚未生成"
                className="font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={() =>
                  draft.token ? void copyText(draft.token, 'Token') : undefined
                }
                disabled={!draft.token}
                title="复制 Token"
                aria-label="复制 Token"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                className="h-8 shrink-0 text-xs"
                onClick={() => void generateToken()}
                disabled={saving}
              >
                <KeyRound className="mr-1 h-3.5 w-3.5" />
                生成
              </Button>
            </div>
          </div>
        </SettingsSection>
      </div>

      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={discard}
        onSave={() => void saveConfig()}
        disabled={saving}
        message="Web 服务配置已修改，保存后生效。"
      />
    </div>
  );
}
