import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Trash2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
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
import { Textarea } from '@/components/ui/textarea';
import type { AgentType } from '@/features/agents/types';
import {
  modelProviderApi,
  type AgentProvider,
  type AgentProviderPayload,
  type AgentProvidersView,
  type RenderedConfigFile,
} from '@/lib/api';

import { SettingsPageHeader, SettingsSection } from './SettingsUi';

const AGENT_OPTIONS: { value: AgentType; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'cline', label: 'Cline' },
  { value: 'hermes', label: 'Hermes' },
];

const AUTH_OPTIONS = [
  { value: 'openai_compatible', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
];

function defaultAuthType(agent: AgentType): string {
  return agent === 'claude_code' ? 'anthropic' : 'openai_compatible';
}

function defaultApiUrl(authType: string): string {
  return authType === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1';
}

interface ProviderDraft {
  name: string;
  api_url: string;
  api_key: string;
  auth_type: string;
  default_model: string;
  wire_api: string;
}

function emptyDraft(agent: AgentType): ProviderDraft {
  const auth = defaultAuthType(agent);
  return {
    name: '',
    api_url: defaultApiUrl(auth),
    api_key: '',
    auth_type: auth,
    default_model: '',
    wire_api: 'chat',
  };
}

function draftFromProvider(provider: AgentProvider, agent: AgentType): ProviderDraft {
  return {
    name: provider.name,
    api_url: provider.api_url,
    api_key: '',
    auth_type: provider.auth_type ?? defaultAuthType(agent),
    default_model: provider.default_model ?? '',
    wire_api: provider.wire_api ?? 'chat',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ModelProviderSettings() {
  const [selectedAgent, setSelectedAgent] = useState<AgentType>('claude_code');
  const [view, setView] = useState<AgentProvidersView | null>(null);
  const [loading, setLoading] = useState(false);

  // Create / edit dialog state.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AgentProvider | null>(
    null
  );
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    emptyDraft('claude_code')
  );
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  // Config-file preview / edit state.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFiles, setPreviewFiles] = useState<RenderedConfigFile[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const isCodex = selectedAgent === 'codex';

  const load = useCallback(async (agent: AgentType) => {
    setLoading(true);
    try {
      const result = await modelProviderApi.list(agent);
      setView(result);
    } catch (error) {
      toast.error('模型供应商加载失败', { description: errorMessage(error) });
      setView(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(selectedAgent);
  }, [load, selectedAgent]);

  const providers = view?.providers ?? [];
  const supportsApply = view?.supports_apply ?? true;
  const configPath = view?.config_path ?? null;

  const openCreate = () => {
    setEditingProvider(null);
    setDraft(emptyDraft(selectedAgent));
    setModels([]);
    setOverrides({});
    setPreviewFiles([]);
    setPreviewOpen(false);
    setDialogOpen(true);
  };

  const openEdit = (provider: AgentProvider) => {
    setEditingProvider(provider);
    setDraft(draftFromProvider(provider, selectedAgent));
    setModels(provider.models ?? []);
    setOverrides({ ...(provider.config_overrides ?? {}) });
    setPreviewFiles([]);
    setPreviewOpen(false);
    setDialogOpen(true);
  };

  const buildPayload = useCallback(
    (includeOverrides: boolean): AgentProviderPayload => ({
      name: draft.name,
      api_url: draft.api_url,
      default_model: draft.default_model.trim() || null,
      models,
      auth_type: draft.auth_type,
      wire_api: isCodex ? draft.wire_api : null,
      api_key: draft.api_key.trim() ? draft.api_key.trim() : null,
      config_overrides: includeOverrides ? overrides : {},
    }),
    [draft, isCodex, models, overrides]
  );

  // Live preview of the config file(s) the form would write.
  useEffect(() => {
    if (!dialogOpen || !previewOpen || !supportsApply) {
      return;
    }
    const payload: AgentProviderPayload = {
      name: draft.name,
      api_url: draft.api_url,
      default_model: draft.default_model.trim() || null,
      models,
      auth_type: draft.auth_type,
      wire_api: isCodex ? draft.wire_api : null,
      api_key: draft.api_key.trim() ? draft.api_key.trim() : null,
      config_overrides: {},
    };
    const handle = setTimeout(() => {
      setPreviewLoading(true);
      void modelProviderApi
        .preview(selectedAgent, payload, editingProvider?.id ?? null)
        .then((files) => setPreviewFiles(files))
        .catch(() => setPreviewFiles([]))
        .finally(() => setPreviewLoading(false));
    }, 350);
    return () => clearTimeout(handle);
  }, [
    dialogOpen,
    previewOpen,
    supportsApply,
    selectedAgent,
    editingProvider,
    draft,
    models,
    isCodex,
  ]);

  const saveProvider = async () => {
    if (!draft.name.trim()) {
      toast.error('请填写供应商名称');
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload(true);
      const result = editingProvider
        ? await modelProviderApi.update(
            selectedAgent,
            editingProvider.id,
            payload
          )
        : await modelProviderApi.create(selectedAgent, payload);
      setView(result);
      toast.success(editingProvider ? '供应商已保存' : '供应商已创建');
      setDialogOpen(false);
    } catch (error) {
      toast.error('供应商保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const applyProvider = async (provider: AgentProvider) => {
    setApplyingId(provider.id);
    try {
      const result = await modelProviderApi.apply(selectedAgent, provider.id);
      setView(result);
      toast.success(`已应用「${provider.name}」`, {
        description: result.config_path
          ? `已写入 ${result.config_path}`
          : undefined,
      });
    } catch (error) {
      toast.error('应用供应商失败', { description: errorMessage(error) });
    } finally {
      setApplyingId(null);
    }
  };

  const deleteProvider = (provider: AgentProvider) => {
    const toastId = toast.warning(`删除 ${provider.name}？`, {
      duration: 8000,
      action: {
        label: '删除',
        onClick: async () => {
          toast.dismiss(toastId);
          try {
            const result = await modelProviderApi.delete(
              selectedAgent,
              provider.id
            );
            setView(result);
            if (editingProvider?.id === provider.id) {
              setDialogOpen(false);
            }
            toast.success('供应商已删除');
          } catch (error) {
            toast.error('供应商删除失败', { description: errorMessage(error) });
          }
        },
      },
      cancel: { label: '取消', onClick: () => toast.dismiss(toastId) },
    });
  };

  const fetchModels = async () => {
    if (!editingProvider) return;
    setModelsLoading(true);
    try {
      const result = await modelProviderApi.fetchModels(
        selectedAgent,
        editingProvider.id
      );
      setModels(result.models);
      toast.success(`已同步 ${result.models.length} 个模型`);
    } catch (error) {
      toast.error('模型列表同步失败', { description: errorMessage(error) });
    } finally {
      setModelsLoading(false);
    }
  };

  const clearApiKey = async () => {
    if (!editingProvider) return;
    try {
      const result = await modelProviderApi.clearApiKey(
        selectedAgent,
        editingProvider.id
      );
      setView(result);
      setEditingProvider(
        result.providers.find((p) => p.id === editingProvider.id) ?? null
      );
      toast.success('API Key 已移除');
    } catch (error) {
      toast.error('API Key 移除失败', { description: errorMessage(error) });
    }
  };

  const editFile = (id: string, content: string) =>
    setOverrides((previous) => ({ ...previous, [id]: content }));

  const resetFile = (id: string) =>
    setOverrides((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });

  const sectionDescription = useMemo(() => {
    const agentLabel =
      AGENT_OPTIONS.find((agent) => agent.value === selectedAgent)?.label ??
      selectedAgent;
    if (!supportsApply) {
      return `${agentLabel} 的供应商配置由其客户端自行管理，VibeX 暂不支持切换写入。`;
    }
    return configPath
      ? `应用后写入 ${configPath}（自动备份原文件）。`
      : `配置 ${agentLabel} 使用的供应商。`;
  }, [configPath, selectedAgent, supportsApply]);

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title="模型供应商"
        description="先选择 Agent，再为其配置供应商；应用后写入该 Agent 的真实配置文件。"
      />

      {/* Agent selector — justified across the full width. */}
      <div className="settings-agent-strip mb-4 flex items-center justify-between gap-1 overflow-x-auto rounded-lg border p-1">
        {AGENT_OPTIONS.map((agent) => {
          const active = agent.value === selectedAgent;
          return (
            <button
              key={agent.value}
              type="button"
              onClick={() => setSelectedAgent(agent.value)}
              className={`settings-agent-tab flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                active ? 'is-active' : ''
              }`}
            >
              <AgentTypeIcon agentType={agent.value} className="h-4 w-4" />
              {agent.label}
            </button>
          );
        })}
      </div>

      <div className="settings-sections">
        <SettingsSection
          icon={Server}
          title="供应商"
          description={sectionDescription}
          action={
            <Button size="sm" className="h-8 text-xs" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              新建供应商
            </Button>
          }
        >
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : providers.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Server className="h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm font-medium">还没有供应商</p>
              <p className="text-xs text-muted-foreground">
                点击右上角「新建供应商」，应用后即可切换该 Agent 的模型接入。
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {providers.map((provider) => (
                <div
                  key={provider.id}
                  className="group flex items-center gap-3 rounded-md px-2.5 py-2 transition-colors hover:bg-[var(--surface-control-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => openEdit(provider)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {provider.name}
                      </span>
                      {provider.is_current ? (
                        <span className="settings-status-pill-success inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium">
                          <CheckCircle2 className="h-3 w-3" />
                          当前
                        </span>
                      ) : null}
                      {provider.auth_type === 'anthropic' ? (
                        <span className="settings-status-pill-neutral shrink-0 px-1.5 py-0.5 text-[10px] font-medium">
                          Anthropic
                        </span>
                      ) : null}
                      {provider.has_api_key ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                          <KeyRound className="h-3 w-3" />
                          Key
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {provider.api_url}
                      {provider.default_model
                        ? ` · ${provider.default_model}`
                        : ''}
                    </div>
                  </button>

                  {supportsApply ? (
                    <Button
                      variant={provider.is_current ? 'outline' : 'default'}
                      size="sm"
                      className="h-8 shrink-0 text-xs"
                      onClick={() => void applyProvider(provider)}
                      disabled={applyingId === provider.id}
                    >
                      {applyingId === provider.id ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Zap className="mr-1 h-3.5 w-3.5" />
                      )}
                      {provider.is_current ? '重新应用' : '应用'}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => openEdit(provider)}
                    title="编辑"
                    aria-label="编辑供应商"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => deleteProvider(provider)}
                    title="删除"
                    aria-label="删除供应商"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editingProvider ? '编辑供应商' : '新建供应商'}
          </DialogTitle>
          <DialogDescription>
            {editingProvider
              ? '更新供应商配置与密钥；若该供应商为当前项，保存后会同步写入配置文件。'
              : '为该 Agent 配置一个供应商，支持 OpenAI 兼容与 Anthropic 协议。'}
          </DialogDescription>
        </DialogHeader>

        <DialogContent>
          <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="provider-name" className="text-xs">
                名称
              </Label>
              <Input
                id="provider-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    name: event.target.value,
                  }))
                }
                placeholder="自定义供应商"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">接口协议</Label>
              <Select
                value={draft.auth_type}
                onValueChange={(value) =>
                  setDraft((previous) => ({ ...previous, auth_type: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTH_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-url" className="text-xs">
              API 地址
            </Label>
            <Input
              id="provider-url"
              value={draft.api_url}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  api_url: event.target.value,
                }))
              }
              placeholder={defaultApiUrl(draft.auth_type)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-key" className="text-xs">
              API 密钥
            </Label>
            <div className="flex gap-2">
              <Input
                id="provider-key"
                type="password"
                value={draft.api_key}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    api_key: event.target.value,
                  }))
                }
                placeholder={
                  editingProvider?.has_api_key
                    ? '已保存，留空保持不变'
                    : '输入 API Key'
                }
              />
              {editingProvider?.has_api_key ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  onClick={() => void clearApiKey()}
                >
                  移除
                </Button>
              ) : null}
            </div>
          </div>

          <div
            className={`grid gap-3 ${isCodex ? 'grid-cols-[minmax(0,1fr)_160px]' : 'grid-cols-1'}`}
          >
            <div className="space-y-1.5">
              <Label htmlFor="provider-model" className="text-xs">
                默认模型
              </Label>
              <Input
                id="provider-model"
                value={draft.default_model}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    default_model: event.target.value,
                  }))
                }
                placeholder={
                  draft.auth_type === 'anthropic'
                    ? 'claude-sonnet-4-6'
                    : 'gpt-4o-mini'
                }
              />
            </div>
            {isCodex ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Wire API</Label>
                <Select
                  value={draft.wire_api}
                  onValueChange={(value) =>
                    setDraft((previous) => ({ ...previous, wire_api: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chat">chat</SelectItem>
                    <SelectItem value="responses">responses</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {editingProvider ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">模型列表</Label>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => void fetchModels()}
                  disabled={modelsLoading}
                >
                  {modelsLoading ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  )}
                  同步模型
                </Button>
              </div>
              {models.length ? (
                <div className="max-h-32 overflow-y-auto rounded-md border border-[var(--border-content)]">
                  {models.slice(0, 30).map((model) => (
                    <button
                      key={model}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--surface-control-hover)]"
                      onClick={() =>
                        setDraft((previous) => ({
                          ...previous,
                          default_model: model,
                        }))
                      }
                    >
                      <span className="min-w-0 truncate">{model}</span>
                      {draft.default_model === model ? (
                        <Check className="h-3.5 w-3.5 text-primary" />
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  从供应商的 `/v1/models` 同步可用模型，点击即可设为默认模型。
                </p>
              )}
            </div>
          ) : null}

          {/* Config file preview + edit (kept in sync with the form). */}
          {supportsApply ? (
            <div className="rounded-lg border border-[var(--border-content)]">
              <button
                type="button"
                onClick={() => setPreviewOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="flex items-center gap-2 text-xs font-medium">
                  <ChevronRight
                    className={`h-3.5 w-3.5 transition-transform ${
                      previewOpen ? 'rotate-90' : ''
                    }`}
                  />
                  预览配置文件
                </span>
                <span className="text-[11px] text-muted-foreground">
                  应用时写入这些文件
                </span>
              </button>

              {previewOpen ? (
                <div className="space-y-3 border-t border-[var(--border-content)] p-3">
                  {previewLoading && previewFiles.length === 0 ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : previewFiles.length === 0 ? (
                    <p className="py-2 text-center text-[11px] text-muted-foreground">
                      填写 API 地址后可预览生成的配置文件。
                    </p>
                  ) : (
                    previewFiles.map((file) => {
                      const overridden = overrides[file.id] !== undefined;
                      const value = overrides[file.id] ?? file.content;
                      return (
                        <div key={file.id} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className="truncate text-[11px] font-medium text-muted-foreground"
                              title={file.path}
                            >
                              {file.path}
                            </span>
                            {overridden ? (
                              <button
                                type="button"
                                onClick={() => resetFile(file.id)}
                                className="inline-flex shrink-0 items-center gap-1 text-[11px] text-primary hover:underline"
                              >
                                <RotateCcw className="h-3 w-3" />
                                恢复与表单同步
                              </button>
                            ) : null}
                          </div>
                          <Textarea
                            value={value}
                            spellCheck={false}
                            onChange={(event) =>
                              editFile(file.id, event.target.value)
                            }
                            className="min-h-32 font-mono text-[11px] leading-relaxed"
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>
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
            取消
          </Button>
          <Button
            type="submit"
            size="sm"
            className="h-8 text-xs"
            onClick={() => void saveProvider()}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1 h-3.5 w-3.5" />
            )}
            {editingProvider ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
