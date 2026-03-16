import { useState, useCallback } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import {
  GripVertical,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Save,
  Eye,
  EyeOff,
  RotateCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type {
  AgentSettingInfo,
  PreflightCheck,
} from '@/lib/api';
import { agentSettingsApi } from '@/lib/api';

// Agent display info
const AGENT_META: Record<
  string,
  { name: string; description: string; icon: string }
> = {
  claude_code: {
    name: 'Claude Code',
    description: 'Anthropic Claude Code - AI 编码助手',
    icon: 'CC',
  },
  codex: {
    name: 'Codex',
    description: 'OpenAI Codex CLI - AI 编码助手',
    icon: 'CX',
  },
  open_code: {
    name: 'OpenCode',
    description: 'OpenCode - 开源 AI 编码助手',
    icon: 'OC',
  },
};

// Codex reasoning effort options
const CODEX_REASONING_EFFORTS = [
  { value: 'low', label: 'Low', description: '快速响应，最少推理' },
  { value: 'medium', label: 'Medium', description: '平衡速度与推理深度' },
  { value: 'high', label: 'High', description: '深度推理，更高质量' },
  { value: 'xhigh', label: 'X-High', description: '最大推理深度' },
];

// Agent draft state
export interface AgentDraft {
  enabled: boolean;
  envText: string;
  // Claude Code
  claudeApiBaseUrl: string;
  claudeApiKey: string;
  claudeMainModel: string;
  claudeReasoningModel: string;
  claudeDefaultHaikuModel: string;
  claudeDefaultSonnetModel: string;
  claudeDefaultOpusModel: string;
  // Codex
  codexModel: string;
  codexModelProvider: string;
  codexReasoningEffort: string;
  codexApiBaseUrl: string;
  codexApiKey: string;
  codexSupportsWebsockets: boolean;
  codexConfigTomlText: string;
  codexAuthJsonText: string;
  // OpenCode
  openCodeModel: string;
  openCodeSmallModel: string;
  openCodeConfigText: string;
  openCodeAuthJsonText: string;
}

function createEmptyDraft(agent: AgentSettingInfo): AgentDraft {
  const envMap = parseEnvJson(agent.env_json);
  const config = parseConfigJson(agent.config_json);

  return {
    enabled: agent.enabled,
    envText: envMapToText(envMap),
    // Claude Code
    claudeApiBaseUrl: envMap['ANTHROPIC_BASE_URL'] ?? '',
    claudeApiKey: envMap['ANTHROPIC_API_KEY'] ?? '',
    claudeMainModel: envMap['ANTHROPIC_MODEL'] ?? '',
    claudeReasoningModel: envMap['ANTHROPIC_REASONING_MODEL'] ?? '',
    claudeDefaultHaikuModel: envMap['ANTHROPIC_DEFAULT_HAIKU_MODEL'] ?? '',
    claudeDefaultSonnetModel: envMap['ANTHROPIC_DEFAULT_SONNET_MODEL'] ?? '',
    claudeDefaultOpusModel: envMap['ANTHROPIC_DEFAULT_OPUS_MODEL'] ?? '',
    // Codex
    codexModel: String(config['model'] ?? ''),
    codexModelProvider: String(config['model_provider'] ?? ''),
    codexReasoningEffort: String(config['reasoning_effort'] ?? 'medium'),
    codexApiBaseUrl: envMap['OPENAI_BASE_URL'] ?? '',
    codexApiKey: envMap['OPENAI_API_KEY'] ?? '',
    codexSupportsWebsockets: config['supports_websockets'] === true,
    codexConfigTomlText: String(config['_codex_config_toml'] ?? ''),
    codexAuthJsonText: String(config['_codex_auth_json'] ?? ''),
    // OpenCode
    openCodeModel: String(config['model'] ?? ''),
    openCodeSmallModel: String(config['small_model'] ?? ''),
    openCodeConfigText: String(config['_opencode_config'] ?? ''),
    openCodeAuthJsonText: String(config['_opencode_auth_json'] ?? ''),
  };
}

function parseEnvJson(envJson: string | null): Record<string, string> {
  if (!envJson) return {};
  try {
    return JSON.parse(envJson);
  } catch {
    return {};
  }
}

function parseConfigJson(configJson: string | null): Record<string, string | boolean> {
  if (!configJson) return {};
  try {
    return JSON.parse(configJson);
  } catch {
    return {};
  }
}

function envMapToText(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }
  return result;
}

function buildEnvJson(agentType: string, draft: AgentDraft): string {
  const base = parseEnvText(draft.envText);

  if (agentType === 'claude_code') {
    const claudeKeys: Record<string, string> = {
      ANTHROPIC_BASE_URL: draft.claudeApiBaseUrl,
      ANTHROPIC_API_KEY: draft.claudeApiKey,
      ANTHROPIC_MODEL: draft.claudeMainModel,
      ANTHROPIC_REASONING_MODEL: draft.claudeReasoningModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: draft.claudeDefaultHaikuModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: draft.claudeDefaultSonnetModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: draft.claudeDefaultOpusModel,
    };
    for (const [k, v] of Object.entries(claudeKeys)) {
      if (v) base[k] = v;
      else delete base[k];
    }
  } else if (agentType === 'codex') {
    if (draft.codexApiBaseUrl) base['OPENAI_BASE_URL'] = draft.codexApiBaseUrl;
    else delete base['OPENAI_BASE_URL'];
    if (draft.codexApiKey) base['OPENAI_API_KEY'] = draft.codexApiKey;
    else delete base['OPENAI_API_KEY'];
  }

  return JSON.stringify(base);
}

function buildConfigJson(agentType: string, draft: AgentDraft): string {
  const config: Record<string, unknown> = {};

  if (agentType === 'codex') {
    if (draft.codexModel) config['model'] = draft.codexModel;
    if (draft.codexModelProvider)
      config['model_provider'] = draft.codexModelProvider;
    config['reasoning_effort'] = draft.codexReasoningEffort;
    config['supports_websockets'] = draft.codexSupportsWebsockets;
    if (draft.codexConfigTomlText)
      config['_codex_config_toml'] = draft.codexConfigTomlText;
    if (draft.codexAuthJsonText)
      config['_codex_auth_json'] = draft.codexAuthJsonText;
  } else if (agentType === 'open_code') {
    if (draft.openCodeModel) config['model'] = draft.openCodeModel;
    if (draft.openCodeSmallModel)
      config['small_model'] = draft.openCodeSmallModel;
    if (draft.openCodeConfigText)
      config['_opencode_config'] = draft.openCodeConfigText;
    if (draft.openCodeAuthJsonText)
      config['_opencode_auth_json'] = draft.openCodeAuthJsonText;
  }

  return JSON.stringify(config);
}

// Preflight status color helpers
function statusIcon(status: string) {
  switch (status) {
    case 'pass':
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case 'warn':
      return <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />;
    case 'fail':
      return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    default:
      return null;
  }
}

function statusBorderClass(status: string | null, enabled: boolean): string {
  if (!enabled) return 'border-muted-foreground/30 bg-muted/30';
  switch (status) {
    case 'pass':
      return 'border-green-500/40 bg-green-500/5';
    case 'warn':
      return 'border-yellow-500/40 bg-yellow-500/5';
    case 'fail':
      return 'border-red-500/40 bg-red-500/5';
    default:
      return '';
  }
}

function summarizeChecks(
  checks: PreflightCheck[]
): 'pass' | 'warn' | 'fail' | null {
  if (checks.length === 0) return null;
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}

// ─── AgentCard Component ───────────────────────────────────────

interface AgentCardProps {
  agent: AgentSettingInfo;
  selected: boolean;
  onSelect: () => void;
  onSave: () => void;
  onReload: () => void;
}

export function AgentCard({
  agent,
  selected,
  onSelect,
  onSave,
  onReload,
}: AgentCardProps) {
  const dragControls = useDragControls();
  const meta = AGENT_META[agent.agent_type] ?? {
    name: agent.agent_type,
    description: '',
    icon: '??',
  };

  const [draft, setDraft] = useState<AgentDraft>(() => createEmptyDraft(agent));
  const [checks, setChecks] = useState<PreflightCheck[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [expandedChecks, setExpandedChecks] = useState<
    Record<string, boolean>
  >({});

  const summary = summarizeChecks(checks);

  const updateDraft = useCallback(
    (patch: Partial<AgentDraft>) => {
      setDraft((prev) => ({ ...prev, ...patch }));
    },
    []
  );

  const handlePreflight = useCallback(async () => {
    setIsChecking(true);
    try {
      const result = await agentSettingsApi.preflight(agent.agent_type);
      setChecks(result.checks);
    } catch {
      setChecks([
        {
          check_id: 'error',
          label: 'Preflight Error',
          status: 'fail',
          message: '无法运行预检查',
          fixes: [],
        },
      ]);
    } finally {
      setIsChecking(false);
    }
  }, [agent.agent_type]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const envJson = buildEnvJson(agent.agent_type, draft);
      const configJson = buildConfigJson(agent.agent_type, draft);
      await agentSettingsApi.updatePreferences({
        agentType: agent.agent_type,
        enabled: draft.enabled,
        envJson,
        configJson,
      });
      onSave();
      onReload();
    } catch (err) {
      // TODO: toast error
    } finally {
      setIsSaving(false);
    }
  }, [agent.agent_type, draft, onSave, onReload]);

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      updateDraft({ enabled });
      try {
        await agentSettingsApi.updatePreferences({
          agentType: agent.agent_type,
          enabled,
        });
        onReload();
      } catch {
        updateDraft({ enabled: !enabled });
      }
    },
    [agent.agent_type, updateDraft, onReload]
  );

  return (
    <Reorder.Item
      as="section"
      value={agent}
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      className={cn(
        'rounded-lg border bg-card p-3 transition-colors cursor-pointer',
        selected && 'border-primary/60 bg-primary/5',
        statusBorderClass(summary, draft.enabled)
      )}
      onClick={onSelect}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
          onPointerDown={(e) => dragControls.start(e)}
          aria-label="Drag to reorder"
        >
          <GripVertical className="h-4 w-4" />
        </button>

        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-xs font-bold">
          {meta.icon}
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{meta.name}</div>
          <div className="text-[11px] text-muted-foreground truncate">
            {agent.installed_version
              ? `v${agent.installed_version}`
              : meta.description}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Preflight summary */}
          {isChecking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
          ) : summary ? (
            statusIcon(summary)
          ) : null}

          <Switch
            checked={draft.enabled}
            onCheckedChange={handleToggleEnabled}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      </div>

      {/* Expanded content when selected */}
      {selected && (
        <div
          className="mt-3 space-y-4 border-t pt-3"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Preflight checks */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                预检查 ({checks.length} 项)
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                onClick={handlePreflight}
                disabled={isChecking}
              >
                {isChecking ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <RotateCw className="h-3 w-3 mr-1" />
                )}
                检查
              </Button>
            </div>
            {checks.map((check) => {
              const key = `${agent.agent_type}:${check.check_id}`;
              const expanded =
                expandedChecks[key] ?? check.status !== 'pass';
              return (
                <div
                  key={check.check_id}
                  className="rounded-md border bg-muted/20 px-3 py-2 space-y-1"
                >
                  <button
                    type="button"
                    className="w-full flex items-center justify-between gap-2 text-left"
                    onClick={() =>
                      setExpandedChecks((prev) => ({
                        ...prev,
                        [key]: !expanded,
                      }))
                    }
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {expanded ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="text-xs font-medium truncate">
                        {check.label}
                      </span>
                    </div>
                    <span
                      className={cn(
                        'text-[11px] font-semibold shrink-0',
                        check.status === 'pass' && 'text-green-500',
                        check.status === 'warn' && 'text-yellow-500',
                        check.status === 'fail' && 'text-red-500'
                      )}
                    >
                      {check.status.toUpperCase()}
                    </span>
                  </button>
                  {expanded && (
                    <div className="text-[11px] text-muted-foreground pl-5">
                      {check.message}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Agent-specific config form */}
          <div className="space-y-3">
            {agent.agent_type === 'claude_code' && (
              <ClaudeCodeFields
                draft={draft}
                onChange={updateDraft}
                showApiKey={showApiKey}
                onToggleApiKey={() => setShowApiKey((p) => !p)}
              />
            )}
            {agent.agent_type === 'codex' && (
              <CodexFields
                draft={draft}
                onChange={updateDraft}
                showApiKey={showApiKey}
                onToggleApiKey={() => setShowApiKey((p) => !p)}
              />
            )}
            {agent.agent_type === 'open_code' && (
              <OpenCodeFields draft={draft} onChange={updateDraft} />
            )}
          </div>

          {/* Environment variables */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">环境变量</Label>
            <Textarea
              value={draft.envText}
              onChange={(e) => updateDraft({ envText: e.target.value })}
              placeholder="KEY1=VALUE1&#10;KEY2=VALUE2"
              className="min-h-20 font-mono text-xs"
            />
          </div>

          {/* Save button */}
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1" />
              )}
              保存配置
            </Button>
          </div>
        </div>
      )}
    </Reorder.Item>
  );
}

// ─── Claude Code Fields ────────────────────────────────────────

function ClaudeCodeFields({
  draft,
  onChange,
  showApiKey,
  onToggleApiKey,
}: {
  draft: AgentDraft;
  onChange: (patch: Partial<AgentDraft>) => void;
  showApiKey: boolean;
  onToggleApiKey: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">
          API Base URL
        </Label>
        <Input
          value={draft.claudeApiBaseUrl}
          onChange={(e) => onChange({ claudeApiBaseUrl: e.target.value })}
          placeholder="https://api.anthropic.com"
          className="h-8 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">API Key</Label>
        <div className="flex items-center gap-2">
          <Input
            type={showApiKey ? 'text' : 'password'}
            value={draft.claudeApiKey}
            onChange={(e) => onChange({ claudeApiKey: e.target.value })}
            placeholder="sk-ant-..."
            className="h-8 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onToggleApiKey}
          >
            {showApiKey ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Main Model
          </Label>
          <Input
            value={draft.claudeMainModel}
            onChange={(e) => onChange({ claudeMainModel: e.target.value })}
            placeholder="claude-sonnet-4-6"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Reasoning Model
          </Label>
          <Input
            value={draft.claudeReasoningModel}
            onChange={(e) =>
              onChange({ claudeReasoningModel: e.target.value })
            }
            placeholder="claude-opus-4-6"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Default Haiku
          </Label>
          <Input
            value={draft.claudeDefaultHaikuModel}
            onChange={(e) =>
              onChange({ claudeDefaultHaikuModel: e.target.value })
            }
            placeholder="claude-haiku-4-5"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Default Sonnet
          </Label>
          <Input
            value={draft.claudeDefaultSonnetModel}
            onChange={(e) =>
              onChange({ claudeDefaultSonnetModel: e.target.value })
            }
            placeholder="claude-sonnet-4-6"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5 col-span-2">
          <Label className="text-[11px] text-muted-foreground">
            Default Opus
          </Label>
          <Input
            value={draft.claudeDefaultOpusModel}
            onChange={(e) =>
              onChange({ claudeDefaultOpusModel: e.target.value })
            }
            placeholder="claude-opus-4-6"
            className="h-8 text-xs"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        留空使用默认模型
      </p>
    </div>
  );
}

// ─── Codex Fields ──────────────────────────────────────────────

function CodexFields({
  draft,
  onChange,
  showApiKey,
  onToggleApiKey,
}: {
  draft: AgentDraft;
  onChange: (patch: Partial<AgentDraft>) => void;
  showApiKey: boolean;
  onToggleApiKey: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Model Provider
          </Label>
          <Input
            value={draft.codexModelProvider}
            onChange={(e) =>
              onChange({ codexModelProvider: e.target.value })
            }
            placeholder="openai"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">Model</Label>
          <Input
            value={draft.codexModel}
            onChange={(e) => onChange({ codexModel: e.target.value })}
            placeholder="gpt-5"
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">
          API Base URL
        </Label>
        <Input
          value={draft.codexApiBaseUrl}
          onChange={(e) => onChange({ codexApiBaseUrl: e.target.value })}
          placeholder="https://api.openai.com/v1"
          className="h-8 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">API Key</Label>
        <div className="flex items-center gap-2">
          <Input
            type={showApiKey ? 'text' : 'password'}
            value={draft.codexApiKey}
            onChange={(e) => onChange({ codexApiKey: e.target.value })}
            placeholder="sk-..."
            className="h-8 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onToggleApiKey}
          >
            {showApiKey ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">
          Reasoning Effort
        </Label>
        <Select
          value={draft.codexReasoningEffort}
          onValueChange={(v) => onChange({ codexReasoningEffort: v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODEX_REASONING_EFFORTS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {CODEX_REASONING_EFFORTS.find(
            (o) => o.value === draft.codexReasoningEffort
          )?.description ?? ''}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-md border px-3 py-2">
        <Label className="text-[11px] text-muted-foreground">
          WebSocket 支持
        </Label>
        <Switch
          checked={draft.codexSupportsWebsockets}
          onCheckedChange={(v) => onChange({ codexSupportsWebsockets: v })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">
          Auth JSON (~/.codex/auth.json)
        </Label>
        <Textarea
          value={draft.codexAuthJsonText}
          onChange={(e) => onChange({ codexAuthJsonText: e.target.value })}
          className="min-h-20 font-mono text-xs"
          placeholder='{"access_token": "..."}'
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">
          Config TOML (~/.codex/config.toml)
        </Label>
        <Textarea
          value={draft.codexConfigTomlText}
          onChange={(e) =>
            onChange({ codexConfigTomlText: e.target.value })
          }
          className="min-h-28 font-mono text-xs"
          placeholder="[model_providers.openai]"
        />
      </div>
    </div>
  );
}

// ─── OpenCode Fields ───────────────────────────────────────────

function OpenCodeFields({
  draft,
  onChange,
}: {
  draft: AgentDraft;
  onChange: (patch: Partial<AgentDraft>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">Model</Label>
          <Input
            value={draft.openCodeModel}
            onChange={(e) => onChange({ openCodeModel: e.target.value })}
            placeholder="google/gemini-3-pro"
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">
            Small Model
          </Label>
          <Input
            value={draft.openCodeSmallModel}
            onChange={(e) =>
              onChange({ openCodeSmallModel: e.target.value })
            }
            placeholder="google/gemini-3-flash"
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">
          Config JSON (~/.config/opencode/opencode.json)
        </Label>
        <Textarea
          value={draft.openCodeConfigText}
          onChange={(e) => onChange({ openCodeConfigText: e.target.value })}
          className="min-h-28 font-mono text-xs"
          placeholder='{"model": "..."}'
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground">
          Auth JSON (~/.config/opencode/auth.json)
        </Label>
        <Textarea
          value={draft.openCodeAuthJsonText}
          onChange={(e) =>
            onChange({ openCodeAuthJsonText: e.target.value })
          }
          className="min-h-20 font-mono text-xs"
          placeholder='{"access_token": "..."}'
        />
      </div>
    </div>
  );
}
