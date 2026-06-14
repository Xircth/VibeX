import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
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
import { Textarea } from '@/components/ui/textarea';
import type { AgentType } from '@/features/agents/types';
import {
  modelProviderApi,
  type ModelProvider,
  type ModelProviderPayload,
} from '@/lib/api';

import { SettingsPageHeader } from './settings-ui';

const AGENT_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'open_code', label: 'OpenCode' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'open_claw', label: 'OpenClaw' },
  { value: 'cline', label: 'Cline' },
  { value: 'hermes', label: 'Hermes' },
];

const ALL_AGENTS = AGENT_OPTIONS.map((agent) => agent.value);

const PROVIDER_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    api_url: 'https://api.openai.com/v1',
    auth_type: 'openai_compatible',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    api_url: 'https://api.deepseek.com/v1',
    auth_type: 'openai_compatible',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    api_url: 'https://openrouter.ai/api/v1',
    auth_type: 'openai_compatible',
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容',
    api_url: 'https://example.com/v1',
    auth_type: 'openai_compatible',
  },
] as const;

interface ProviderDraft {
  name: string;
  agent_types: string[];
  api_url: string;
  auth_type: string;
  default_model: string;
  config_json: string;
}

function emptyDraft(): ProviderDraft {
  return {
    name: '',
    agent_types: [...ALL_AGENTS],
    api_url: 'https://api.openai.com/v1',
    auth_type: 'openai_compatible',
    default_model: '',
    config_json: '',
  };
}

function draftFromProvider(provider: ModelProvider): ProviderDraft {
  return {
    name: provider.name,
    agent_types: provider.agent_types.length
      ? provider.agent_types
      : [...ALL_AGENTS],
    api_url: provider.api_url,
    auth_type: provider.auth_type,
    default_model: provider.default_model ?? '',
    config_json: provider.config_json ?? '',
  };
}

function payloadFromDraft(draft: ProviderDraft): ModelProviderPayload {
  return {
    name: draft.name,
    agent_types: draft.agent_types,
    api_url: draft.api_url,
    auth_type: draft.auth_type,
    default_model: draft.default_model.trim() || null,
    config_json: draft.config_json.trim() || null,
  };
}

function sameDraft(a: ProviderDraft, b: ProviderDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ModelProviderSettings() {
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyDraft());
  const [baseline, setBaseline] = useState<ProviderDraft>(() => emptyDraft());
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId]
  );

  const dirty = useMemo(() => !sameDraft(draft, baseline), [baseline, draft]);

  const visibleProviders = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return providers;
    return providers.filter(
      (provider) =>
        provider.name.toLowerCase().includes(query) ||
        provider.api_url.toLowerCase().includes(query)
    );
  }, [providers, search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await modelProviderApi.list();
      setProviders(list);
      if (selectedId && !list.some((provider) => provider.id === selectedId)) {
        setSelectedId(null);
        const next = emptyDraft();
        setDraft(next);
        setBaseline(next);
      }
    } catch (error) {
      toast.error('模型供应商加载失败', { description: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedProvider) {
      return;
    }
    const next = draftFromProvider(selectedProvider);
    setDraft(next);
    setBaseline(next);
    setApiKeyDraft('');
    setModels([]);
  }, [selectedProvider]);

  const startCreate = () => {
    const next = emptyDraft();
    setSelectedId(null);
    setDraft(next);
    setBaseline(next);
    setApiKeyDraft('');
    setModels([]);
  };

  const applyPreset = (presetId: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setDraft((previous) => ({
      ...previous,
      name: previous.name || preset.label,
      api_url: preset.api_url,
      auth_type: preset.auth_type,
    }));
  };

  const toggleAgent = (agentType: string, checked: boolean) => {
    setDraft((previous) => ({
      ...previous,
      agent_types: checked
        ? [...new Set([...previous.agent_types, agentType])]
        : previous.agent_types.filter((agent) => agent !== agentType),
    }));
  };

  const saveProvider = async () => {
    setSaving(true);
    try {
      const payload = payloadFromDraft(draft);
      const provider = selectedProvider
        ? await modelProviderApi.update(selectedProvider.id, payload)
        : await modelProviderApi.create(payload);
      await refresh();
      setSelectedId(provider.id);
      const next = draftFromProvider(provider);
      setDraft(next);
      setBaseline(next);
      toast.success(selectedProvider ? '供应商已保存' : '供应商已创建');
    } catch (error) {
      toast.error('供应商保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteProvider = () => {
    if (!selectedProvider) return;
    const toastId = toast.warning(`删除 ${selectedProvider.name}？`, {
      duration: 8000,
      action: {
        label: '删除',
        onClick: async () => {
          toast.dismiss(toastId);
          try {
            await modelProviderApi.delete(selectedProvider.id);
            toast.success('供应商已删除');
            startCreate();
            await refresh();
          } catch (error) {
            toast.error('供应商删除失败', { description: errorMessage(error) });
          }
        },
      },
      cancel: {
        label: '取消',
        onClick: () => toast.dismiss(toastId),
      },
    });
  };

  const saveApiKey = async () => {
    if (!selectedProvider) return;
    setSaving(true);
    try {
      const updated = await modelProviderApi.saveApiKey(
        selectedProvider.id,
        apiKeyDraft
      );
      setProviders((previous) =>
        previous.map((provider) =>
          provider.id === updated.id ? updated : provider
        )
      );
      setApiKeyDraft('');
      toast.success('API Key 已保存');
    } catch (error) {
      toast.error('API Key 保存失败', { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteApiKey = async () => {
    if (!selectedProvider) return;
    try {
      await modelProviderApi.deleteApiKey(selectedProvider.id);
      setProviders((previous) =>
        previous.map((provider) =>
          provider.id === selectedProvider.id
            ? { ...provider, has_api_key: false }
            : provider
        )
      );
      toast.success('API Key 已移除');
    } catch (error) {
      toast.error('API Key 移除失败', { description: errorMessage(error) });
    }
  };

  const fetchModels = async () => {
    if (!selectedProvider) return;
    setModelsLoading(true);
    try {
      const result = await modelProviderApi.fetchModels(selectedProvider.id);
      setModels(result.models);
      toast.success(`已同步 ${result.models.length} 个模型`);
    } catch (error) {
      toast.error('模型列表同步失败', { description: errorMessage(error) });
    } finally {
      setModelsLoading(false);
    }
  };

  const activateForAgent = async (agentType: string) => {
    if (!selectedProvider) return;
    try {
      await modelProviderApi.activate(selectedProvider.id, agentType);
      await refresh();
      toast.success('已设为该 Agent 的默认供应商');
    } catch (error) {
      toast.error('激活供应商失败', { description: errorMessage(error) });
    }
  };

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title="模型供应商"
        description="管理 OpenAI-compatible 供应商、密钥、模型列表与 Agent 默认供应商。"
      />

      <div className="grid min-h-[560px] grid-cols-[280px_minmax(0,1fr)] gap-4">
        <aside className="settings-card flex min-h-0 flex-col">
          <div className="settings-card__header">
            <div>
              <h3>供应商</h3>
              <p>{providers.length} 个本地配置</p>
            </div>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={startCreate}
            >
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
                placeholder="搜索供应商"
                className="pl-8"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : visibleProviders.length === 0 ? (
              <div className="settings-empty-state">暂无供应商</div>
            ) : (
              visibleProviders.map((provider) => {
                const selected = provider.id === selectedId;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => setSelectedId(provider.id)}
                    className={`mb-1 w-full rounded-md px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'bg-primary/10 text-foreground'
                        : 'hover:bg-muted/70'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {provider.name}
                      </span>
                      {provider.has_api_key ? (
                        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : null}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {provider.api_url}
                    </div>
                    {provider.active_agents.length ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {provider.active_agents.map((agent) => (
                          <span
                            key={agent}
                            className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                          >
                            {agent}
                          </span>
                        ))}
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
              <h3>{selectedProvider ? selectedProvider.name : '新建供应商'}</h3>
              <p>
                {selectedProvider
                  ? '编辑供应商配置并管理密钥'
                  : '创建新的 OpenAI-compatible 供应商'}
              </p>
            </div>
            <div className="flex gap-2">
              {selectedProvider ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={deleteProvider}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              ) : null}
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={() => void saveProvider()}
                disabled={saving || (!dirty && !!selectedProvider)}
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

          <div className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-3">
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
                  placeholder="OpenAI"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">预设</Label>
                <Select value="" onValueChange={applyPreset}>
                  <SelectTrigger>
                    <SelectValue placeholder="应用供应商预设" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-3">
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
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">认证类型</Label>
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
                    <SelectItem value="openai_compatible">
                      OpenAI Compatible
                    </SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="gemini">Gemini</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

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
                placeholder="gpt-4o-mini"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs">可用 Agent</Label>
              <div className="grid grid-cols-2 gap-2">
                {AGENT_OPTIONS.map((agent) => {
                  const checked = draft.agent_types.includes(agent.value);
                  return (
                    <button
                      key={agent.value}
                      type="button"
                      onClick={() => toggleAgent(agent.value, !checked)}
                      className="flex items-center gap-2 rounded-md border border-border/70 px-2.5 py-2 text-left text-xs hover:bg-muted/70"
                    >
                      <Checkbox checked={checked} className="pointer-events-none" />
                      <AgentTypeIcon
                        agentType={agent.value as AgentType}
                        className="h-4 w-4"
                      />
                      <span>{agent.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="provider-json" className="text-xs">
                自定义 JSON
              </Label>
              <Textarea
                id="provider-json"
                value={draft.config_json}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    config_json: event.target.value,
                  }))
                }
                placeholder='{"headers":{"X-Provider":"vibex"}}'
                className="min-h-24 font-mono text-xs"
              />
            </div>

            {selectedProvider ? (
              <div className="space-y-4 border-t border-border/70 pt-4">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">API Key</Label>
                    <Input
                      type="password"
                      value={apiKeyDraft}
                      onChange={(event) => setApiKeyDraft(event.target.value)}
                      placeholder={
                        selectedProvider.has_api_key
                          ? '已保存，输入新值可替换'
                          : '输入 API Key'
                      }
                    />
                  </div>
                  <Button
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => void saveApiKey()}
                    disabled={!apiKeyDraft.trim() || saving}
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                    保存密钥
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => void deleteApiKey()}
                    disabled={!selectedProvider.has_api_key}
                  >
                    移除
                  </Button>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold">模型列表</div>
                      <div className="text-[11px] text-muted-foreground">
                        从供应商的 OpenAI-compatible `/v1/models` 同步。
                      </div>
                    </div>
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
                    <div className="max-h-32 overflow-y-auto rounded-md border border-border/70">
                      {models.slice(0, 20).map((model) => (
                        <button
                          key={model}
                          type="button"
                          className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/70"
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
                  ) : null}
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-semibold">Agent 默认供应商</div>
                  <div className="grid grid-cols-2 gap-2">
                    {AGENT_OPTIONS.map((agent) => {
                      const active = selectedProvider.active_agents.includes(
                        agent.value
                      );
                      return (
                        <Button
                          key={agent.value}
                          variant={active ? 'default' : 'outline'}
                          size="sm"
                          className="h-8 justify-start text-xs"
                          onClick={() => void activateForAgent(agent.value)}
                        >
                          <AgentTypeIcon
                            agentType={agent.value as AgentType}
                            className="mr-1 h-3.5 w-3.5"
                          />
                          {agent.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
