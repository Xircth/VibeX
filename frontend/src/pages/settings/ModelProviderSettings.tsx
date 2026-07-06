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
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation(['settings', 'common']);
  const AUTH_OPTIONS = useMemo(
    () => [
      {
        value: 'openai_compatible',
        label: t('modelProviders.authOpenAICompatible'),
      },
      { value: 'anthropic', label: 'Anthropic' },
    ],
    [t]
  );
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
      toast.error(t('modelProviders.loadFailed'), {
        description: errorMessage(error),
      });
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      toast.error(t('modelProviders.nameRequired'));
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
      toast.success(
        editingProvider
          ? t('modelProviders.providerSaved')
          : t('modelProviders.providerCreated')
      );
      setDialogOpen(false);
    } catch (error) {
      toast.error(t('modelProviders.saveFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const applyProvider = async (provider: AgentProvider) => {
    setApplyingId(provider.id);
    try {
      const result = await modelProviderApi.apply(selectedAgent, provider.id);
      setView(result);
      toast.success(t('modelProviders.applied', { name: provider.name }), {
        description: result.config_path
          ? t('modelProviders.writtenTo', { path: result.config_path })
          : undefined,
      });
    } catch (error) {
      toast.error(t('modelProviders.applyFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setApplyingId(null);
    }
  };

  const deleteProvider = (provider: AgentProvider) => {
    const toastId = toast.warning(
      t('modelProviders.deleteConfirm', { name: provider.name }),
      {
        duration: 8000,
        action: {
          label: t('common:delete'),
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
              toast.success(t('modelProviders.providerDeleted'));
            } catch (error) {
              toast.error(t('modelProviders.deleteFailed'), {
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

  const fetchModels = async () => {
    if (!editingProvider) return;
    setModelsLoading(true);
    try {
      const result = await modelProviderApi.fetchModels(
        selectedAgent,
        editingProvider.id
      );
      setModels(result.models);
      toast.success(
        t('modelProviders.modelsSynced', { num: result.models.length })
      );
    } catch (error) {
      toast.error(t('modelProviders.modelsSyncFailed'), {
        description: errorMessage(error),
      });
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
      toast.success(t('modelProviders.apiKeyRemoved'));
    } catch (error) {
      toast.error(t('modelProviders.apiKeyRemoveFailed'), {
        description: errorMessage(error),
      });
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
      return t('modelProviders.unmanagedDescription', { agent: agentLabel });
    }
    return configPath
      ? t('modelProviders.applyWritesTo', { path: configPath })
      : t('modelProviders.configureDescription', { agent: agentLabel });
  }, [configPath, selectedAgent, supportsApply, t]);

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title={t('modelProviders.title')}
        description={t('modelProviders.pageDescription')}
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
          title={t('modelProviders.sectionTitle')}
          description={sectionDescription}
          action={
            <Button size="sm" className="h-8 text-xs" onClick={openCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('modelProviders.newProvider')}
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
              <p className="text-sm font-medium">
                {t('modelProviders.emptyTitle')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('modelProviders.emptyDescription')}
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
                          {t('modelProviders.currentBadge')}
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
                      {provider.is_current
                        ? t('modelProviders.reapply')
                        : t('modelProviders.apply')}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => openEdit(provider)}
                    title={t('modelProviders.edit')}
                    aria-label={t('modelProviders.editProvider')}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => deleteProvider(provider)}
                    title={t('common:delete')}
                    aria-label={t('modelProviders.deleteProvider')}
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
            {editingProvider
              ? t('modelProviders.editProvider')
              : t('modelProviders.newProvider')}
          </DialogTitle>
          <DialogDescription>
            {editingProvider
              ? t('modelProviders.editDialogDescription')
              : t('modelProviders.createDialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <DialogContent>
          <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="provider-name" className="text-xs">
                {t('modelProviders.nameLabel')}
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
                placeholder={t('modelProviders.namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t('modelProviders.authTypeLabel')}
              </Label>
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
              {t('modelProviders.apiUrlLabel')}
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
              {t('modelProviders.apiKeyLabel')}
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
                    ? t('modelProviders.apiKeySavedPlaceholder')
                    : t('modelProviders.apiKeyPlaceholder')
                }
              />
              {editingProvider?.has_api_key ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  onClick={() => void clearApiKey()}
                >
                  {t('modelProviders.remove')}
                </Button>
              ) : null}
            </div>
          </div>

          <div
            className={`grid gap-3 ${isCodex ? 'grid-cols-[minmax(0,1fr)_160px]' : 'grid-cols-1'}`}
          >
            <div className="space-y-1.5">
              <Label htmlFor="provider-model" className="text-xs">
                {t('modelProviders.defaultModelLabel')}
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
                <Label className="text-xs">
                  {t('modelProviders.modelListLabel')}
                </Label>
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
                  {t('modelProviders.syncModels')}
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
                  {t('modelProviders.modelListHint')}
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
                  {t('modelProviders.previewConfigFiles')}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t('modelProviders.previewWriteHint')}
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
                      {t('modelProviders.previewEmpty')}
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
                                {t('modelProviders.resetToForm')}
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
            {t('common:cancel')}
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
            {editingProvider ? t('common:save') : t('modelProviders.create')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
