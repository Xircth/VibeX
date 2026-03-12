/**
 * Codex agent configuration form.
 *
 * Fields:
 * - Provider select (from config.toml sections)
 * - API Base URL
 * - API Key (password + visibility toggle)
 * - Model name
 * - Reasoning Effort select
 * - WebSocket switch
 * - Auth JSON textarea (from ~/.codex/auth.json)
 * - Config TOML textarea (from ~/.codex/config.toml)
 */

import { useState, useMemo } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AgentDraft } from '@/lib/agentConfigUtils';
import {
  CODEX_REASONING_EFFORT_OPTIONS,
  extractCodexProviderOptions,
} from '@/lib/agentConfigUtils';

interface CodexFormProps {
  draft: AgentDraft;
  onDraftChange: (patch: Partial<AgentDraft>) => void;
  disabled?: boolean;
}

export function CodexForm({
  draft,
  onDraftChange,
  disabled = false,
}: CodexFormProps) {
  const [showApiKey, setShowApiKey] = useState(false);

  const providerOptions = useMemo(
    () => extractCodexProviderOptions(draft.codexConfigTomlText),
    [draft.codexConfigTomlText]
  );

  return (
    <div className="space-y-6">
      {/* Provider + Model row */}
      <div className="grid grid-cols-2 gap-3">
        {/* Provider */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Provider</Label>
          <Select
            value={draft.codexModelProvider || '__none__'}
            onValueChange={(val) =>
              onDraftChange({
                codexModelProvider:
                  val === '__none__' ? '' : val,
              })
            }
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select provider..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Default</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="azure">Azure</SelectItem>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              {providerOptions
                .filter(
                  (p) =>
                    !['openai', 'azure', 'anthropic'].includes(p)
                )
                .map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {provider}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        {/* Model */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Model</Label>
          <Input
            value={draft.codexModel}
            onChange={(e) =>
              onDraftChange({ codexModel: e.target.value })
            }
            placeholder="o4-mini"
            disabled={disabled}
          />
        </div>
      </div>

      {/* API Base URL */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">API Base URL</Label>
        <Input
          value={draft.codexApiBaseUrl}
          onChange={(e) =>
            onDraftChange({ codexApiBaseUrl: e.target.value })
          }
          placeholder="https://api.openai.com/v1"
          disabled={disabled}
        />
      </div>

      {/* API Key */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">API Key</Label>
        <div className="relative">
          <Input
            type={showApiKey ? 'text' : 'password'}
            value={draft.codexApiKey}
            onChange={(e) =>
              onDraftChange({ codexApiKey: e.target.value })
            }
            placeholder="sk-..."
            disabled={disabled}
            className="pr-10"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
            onClick={() => setShowApiKey((prev) => !prev)}
            tabIndex={-1}
          >
            {showApiKey ? (
              <EyeOff className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Eye className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          存储在 ~/.codex/auth.json 中
        </p>
      </div>

      {/* Reasoning Effort + WebSocket row */}
      <div className="grid grid-cols-2 gap-3">
        {/* Reasoning Effort */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">
            Reasoning Effort
          </Label>
          <Select
            value={draft.codexReasoningEffort}
            onValueChange={(val) =>
              onDraftChange({
                codexReasoningEffort: val as AgentDraft['codexReasoningEffort'],
              })
            }
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODEX_REASONING_EFFORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span>{opt.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {opt.description}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* WebSocket */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">WebSocket</Label>
          <div className="flex items-center gap-2 pt-1.5">
            <Switch
              checked={draft.codexSupportsWebsockets}
              onCheckedChange={(checked) =>
                onDraftChange({
                  codexSupportsWebsockets: checked,
                })
              }
              disabled={disabled}
            />
            <span className="text-sm text-muted-foreground">
              {draft.codexSupportsWebsockets
                ? 'Enabled'
                : 'Disabled'}
            </span>
          </div>
        </div>
      </div>

      {/* Environment Variables */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          Environment Variables
        </Label>
        <Textarea
          value={draft.envText}
          onChange={(e) =>
            onDraftChange({ envText: e.target.value })
          }
          placeholder="# KEY=VALUE format"
          className="font-mono text-xs min-h-[80px]"
          disabled={disabled}
        />
      </div>

      {/* Auth JSON */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          auth.json
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ~/.codex/auth.json
          </span>
        </Label>
        <Textarea
          value={draft.codexAuthJsonText}
          onChange={(e) =>
            onDraftChange({ codexAuthJsonText: e.target.value })
          }
          placeholder='{"OPENAI_API_KEY": "sk-..."}'
          className="font-mono text-xs min-h-[80px]"
          disabled={disabled}
        />
      </div>

      {/* Config TOML */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          config.toml
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ~/.codex/config.toml
          </span>
        </Label>
        <Textarea
          value={draft.codexConfigTomlText}
          onChange={(e) =>
            onDraftChange({ codexConfigTomlText: e.target.value })
          }
          placeholder={
            '# Codex configuration\nmodel = "o4-mini"\nmodel_provider = "openai"'
          }
          className="font-mono text-xs min-h-[120px]"
          disabled={disabled}
        />
      </div>
    </div>
  );
}
