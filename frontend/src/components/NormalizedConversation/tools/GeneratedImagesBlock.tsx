import { ImageIcon } from 'lucide-react';
import type { JsonValue, NormalizedEntry } from 'shared/types';
import { renderJson } from '../conversation-entry-utils';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

function isRecord(value: JsonValue | null | undefined): value is {
  [key: string]: JsonValue | undefined;
} {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(
  value: JsonValue | null | undefined,
  keys: string[]
): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

function isRenderableImageUrl(value: string | null): value is string {
  return Boolean(
    value &&
      (value.startsWith('http://') ||
        value.startsWith('https://') ||
        value.startsWith('data:image/') ||
        value.startsWith('blob:'))
  );
}

function isGeneratedImageToolName(toolName: string): boolean {
  return /imagegen|generate.*image|generated_image|image_generation/i.test(
    toolName
  );
}

export function isGeneratedImageToolEntry(entry: NormalizedEntry): boolean {
  return (
    entry.entry_type.type === 'tool_use' &&
    entry.entry_type.action_type.action === 'tool' &&
    isGeneratedImageToolName(entry.entry_type.action_type.tool_name)
  );
}

export function GeneratedImagesBlock({ entry }: { entry: NormalizedEntry }) {
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action =
    toolEntry?.action_type.action === 'tool' ? toolEntry.action_type : null;
  if (!toolEntry || !action) return null;

  const resultValue = action.result?.value;
  const prompt = readString(action.arguments, ['prompt', 'description']);
  const revisedPrompt = readString(resultValue, [
    'revised_prompt',
    'revisedPrompt',
  ]);
  const imageUrl = readString(resultValue, ['url', 'image_url', 'image']);
  const status =
    readString(resultValue, ['status', 'state']) ||
    (toolEntry.status.status === 'created' ? 'generating' : 'ready');
  const error = readString(resultValue, ['error', 'message']);
  const detail = error || revisedPrompt || prompt || status;

  return (
    <ToolCardShell
      icon={<ImageIcon className="h-3 w-3" />}
      label="图片"
      detail={detail}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      expanded
      expandable={false}
    >
      <div className="space-y-2 font-sans">
        {isRenderableImageUrl(imageUrl) ? (
          <img
            src={imageUrl}
            alt={revisedPrompt || prompt || 'Generated image'}
            className="max-h-64 max-w-full rounded-md border border-border object-contain"
          />
        ) : imageUrl ? (
          <div className="conv-tool-details-content font-mono">{imageUrl}</div>
        ) : null}
        {prompt ? (
          <div>
            <div className="conv-tool-details-section-label">提示词</div>
            <div className="conv-tool-details-content">{prompt}</div>
          </div>
        ) : null}
        {revisedPrompt ? (
          <div>
            <div className="conv-tool-details-section-label">修订提示词</div>
            <div className="conv-tool-details-content">{revisedPrompt}</div>
          </div>
        ) : null}
        {error ? (
          <div>
            <div className="conv-tool-details-section-label">错误</div>
            <div className="conv-tool-details-content">{error}</div>
          </div>
        ) : null}
        {action.result ? (
          <div>
            <div className="conv-tool-details-section-label">原始结果</div>
            <div className="conv-tool-details-content">
              {renderJson(action.result.value)}
            </div>
          </div>
        ) : null}
      </div>
    </ToolCardShell>
  );
}
