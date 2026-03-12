/**
 * Claude Code agent configuration form.
 *
 * Fields:
 * - API Base URL (ANTHROPIC_BASE_URL)
 * - API Key (password + visibility toggle)
 * - 5 model fields in a 2x2+1 grid layout
 * - Raw JSON config textarea
 */

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { AgentDraft } from '@/lib/agentConfigUtils';

interface ClaudeCodeFormProps {
  draft: AgentDraft;
  onDraftChange: (patch: Partial<AgentDraft>) => void;
  disabled?: boolean;
}

export function ClaudeCodeForm({
  draft,
  onDraftChange,
  disabled = false,
}: ClaudeCodeFormProps) {
  const [showApiKey, setShowApiKey] = useState(false);

  return (
    <div className="space-y-6">
      {/* API Base URL */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">API Base URL</Label>
        <Input
          value={draft.claudeApiBaseUrl}
          onChange={(e) =>
            onDraftChange({ claudeApiBaseUrl: e.target.value })
          }
          placeholder="https://api.anthropic.com"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          Anthropic API 或兼容的代理地址
        </p>
      </div>

      {/* API Key */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">API Key</Label>
        <div className="relative">
          <Input
            type={showApiKey ? 'text' : 'password'}
            value={draft.claudeApiKey}
            onChange={(e) =>
              onDraftChange({ claudeApiKey: e.target.value })
            }
            placeholder="sk-ant-..."
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
          ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
        </p>
      </div>

      {/* Model fields - 2x2+1 grid */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">Models</Label>

        <div className="grid grid-cols-2 gap-3">
          {/* Main Model */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Main Model
            </Label>
            <Input
              value={draft.claudeMainModel}
              onChange={(e) =>
                onDraftChange({ claudeMainModel: e.target.value })
              }
              placeholder="claude-sonnet-4-6"
              disabled={disabled}
            />
          </div>

          {/* Reasoning Model */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Reasoning Model
            </Label>
            <Input
              value={draft.claudeReasoningModel}
              onChange={(e) =>
                onDraftChange({
                  claudeReasoningModel: e.target.value,
                })
              }
              placeholder="claude-opus-4-6"
              disabled={disabled}
            />
          </div>

          {/* Haiku Default */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Default Haiku Model
            </Label>
            <Input
              value={draft.claudeDefaultHaikuModel}
              onChange={(e) =>
                onDraftChange({
                  claudeDefaultHaikuModel: e.target.value,
                })
              }
              placeholder="claude-haiku-4-5"
              disabled={disabled}
            />
          </div>

          {/* Sonnet Default */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Default Sonnet Model
            </Label>
            <Input
              value={draft.claudeDefaultSonnetModel}
              onChange={(e) =>
                onDraftChange({
                  claudeDefaultSonnetModel: e.target.value,
                })
              }
              placeholder="claude-sonnet-4-6"
              disabled={disabled}
            />
          </div>
        </div>

        {/* Opus Default - full width */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            Default Opus Model
          </Label>
          <Input
            value={draft.claudeDefaultOpusModel}
            onChange={(e) =>
              onDraftChange({
                claudeDefaultOpusModel: e.target.value,
              })
            }
            placeholder="claude-opus-4-6"
            disabled={disabled}
          />
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
          placeholder={'# KEY=VALUE format\nANTHROPIC_BASE_URL=https://...'}
          className="font-mono text-xs min-h-[100px]"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          额外的环境变量，每行一个 KEY=VALUE
        </p>
      </div>

      {/* Raw JSON Config */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          Raw Configuration (JSON)
        </Label>
        <Textarea
          value={draft.configText}
          onChange={(e) =>
            onDraftChange({ configText: e.target.value })
          }
          placeholder="{}"
          className="font-mono text-xs min-h-[120px]"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          profiles.json 中的完整配置对象
        </p>
      </div>
    </div>
  );
}
