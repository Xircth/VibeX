/**
 * OpenCode agent configuration form.
 *
 * Fields:
 * - Model + Small Model (2 columns)
 * - Environment Variables textarea
 * - Native config JSON textarea
 * - Auth JSON textarea
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AgentDraft } from '@/lib/agentConfigUtils';

interface OpenCodeFormProps {
  draft: AgentDraft;
  onDraftChange: (patch: Partial<AgentDraft>) => void;
  disabled?: boolean;
}

export function OpenCodeForm({
  draft,
  onDraftChange,
  disabled = false,
}: OpenCodeFormProps) {
  return (
    <div className="space-y-6">
      {/* Model fields - 2 columns */}
      <div className="grid grid-cols-2 gap-3">
        {/* Main Model */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Model</Label>
          <Input
            value={draft.openCodeModel}
            onChange={(e) =>
              onDraftChange({ openCodeModel: e.target.value })
            }
            placeholder="claude-sonnet-4-6"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            主要模型名称
          </p>
        </div>

        {/* Small Model */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Small Model</Label>
          <Input
            value={draft.openCodeSmallModel}
            onChange={(e) =>
              onDraftChange({
                openCodeSmallModel: e.target.value,
              })
            }
            placeholder="claude-haiku-4-5"
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            轻量级模型，用于快速任务
          </p>
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

      {/* Native Config JSON */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          opencode.json
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ~/.config/opencode/opencode.json
          </span>
        </Label>
        <Textarea
          value={draft.openCodeConfigText}
          onChange={(e) =>
            onDraftChange({ openCodeConfigText: e.target.value })
          }
          placeholder='{"model": "claude-sonnet-4-6", "small_model": "claude-haiku-4-5"}'
          className="font-mono text-xs min-h-[120px]"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          OpenCode 原生配置文件内容
        </p>
      </div>

      {/* Auth JSON */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          auth.json
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            ~/.local/share/opencode/auth.json
          </span>
        </Label>
        <Textarea
          value={draft.openCodeAuthJsonText}
          onChange={(e) =>
            onDraftChange({
              openCodeAuthJsonText: e.target.value,
            })
          }
          placeholder='{"api_key": "..."}'
          className="font-mono text-xs min-h-[80px]"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          OpenCode 认证信息
        </p>
      </div>
    </div>
  );
}
