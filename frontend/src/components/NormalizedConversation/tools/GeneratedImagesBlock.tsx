import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageIcon, Loader2 } from 'lucide-react';
import type { JsonValue, NormalizedEntry } from 'shared/types';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { ToolArtifact, ToolProse } from './ToolArtifact';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';
import { isRecord, readString } from './jsonValue';

function readFirstRecord(
  value: JsonValue | null | undefined,
  keys: string[]
): JsonValue | null {
  if (!isRecord(value)) return null;

  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate[0] ?? null;
    }
    if (isRecord(candidate)) {
      return candidate;
    }
  }

  return null;
}

function dataUrlFromRecord(value: JsonValue | null | undefined): string | null {
  if (!isRecord(value)) return null;

  const dataBase64 = readString(value, ['data_base64', 'base64', 'b64_json']);
  const mimeType = readString(value, ['mime_type', 'mimeType']) || 'image/png';

  return dataBase64 && mimeType.startsWith('image/')
    ? `data:${mimeType};base64,${dataBase64}`
    : null;
}

function readGeneratedImageUrl(
  value: JsonValue | null | undefined
): string | null {
  const directUrl = readString(value, [
    'url',
    'image_url',
    'imageUrl',
    'image',
    'path',
    'file_path',
  ]);

  if (directUrl) return directUrl;

  const directDataUrl = dataUrlFromRecord(value);
  if (directDataUrl) return directDataUrl;

  const nestedImage = readFirstRecord(value, [
    'images',
    'generated_images',
    'generatedImages',
    'output',
  ]);

  if (nestedImage === null) return null;
  if (typeof nestedImage === 'string') return nestedImage;
  return (
    readGeneratedImageUrl(nestedImage) || dataUrlFromRecord(nestedImage) || null
  );
}

function isRenderableImageUrl(value: string | null): value is string {
  return Boolean(
    value &&
      (value.startsWith('http://') ||
        value.startsWith('https://') ||
        value.startsWith('data:image/') ||
        value.startsWith('blob:') ||
        value.startsWith('.vibe-images/'))
  );
}

function isDirectImageUrl(value: string | null): value is string {
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

function getStatusText(
  status: string,
  hasError: boolean,
  t: (key: string) => string
): string {
  if (hasError) return t('generatedImages.statusFailed');

  const normalized = status.toLowerCase();
  if (
    normalized === 'generating' ||
    normalized === 'running' ||
    normalized === 'created' ||
    normalized === 'pending'
  ) {
    return t('generatedImages.statusGenerating');
  }

  if (
    normalized === 'ready' ||
    normalized === 'success' ||
    normalized === 'succeeded' ||
    normalized === 'completed'
  ) {
    return t('generatedImages.statusCompleted');
  }

  if (normalized === 'failed' || normalized === 'error') {
    return t('generatedImages.statusFailed');
  }

  return status;
}

export function isGeneratedImageToolEntry(entry: NormalizedEntry): boolean {
  return (
    entry.entry_type.type === 'tool_use' &&
    entry.entry_type.action_type.action === 'tool' &&
    isGeneratedImageToolName(entry.entry_type.action_type.tool_name)
  );
}

export function GeneratedImagesBlock({
  entry,
  taskAttemptId,
}: {
  entry: NormalizedEntry;
  taskAttemptId?: string;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action =
    toolEntry?.action_type.action === 'tool' ? toolEntry.action_type : null;
  const resultValue = action?.result?.value;
  const imagePath = readGeneratedImageUrl(resultValue);
  const { data: metadata, isLoading } = useImageMetadata(
    taskAttemptId,
    imagePath ?? ''
  );
  const openImagePreview = useOpenImagePreview();

  const prompt = readString(action?.arguments, ['prompt', 'description']);
  const revisedPrompt = readString(resultValue, [
    'revised_prompt',
    'revisedPrompt',
  ]);
  const status =
    readString(resultValue, ['status', 'state']) ||
    (toolEntry?.status.status === 'created' ? 'generating' : 'ready');
  const error = readString(resultValue, ['error', 'message']);
  const statusText = getStatusText(status, Boolean(error), t);
  const resolvedImageUrl = metadata?.proxy_url || imagePath;
  const previewImageUrl = isDirectImageUrl(resolvedImageUrl)
    ? resolvedImageUrl
    : metadata?.proxy_url || null;
  const detail = error || revisedPrompt || prompt || statusText;
  const label =
    revisedPrompt ||
    prompt ||
    metadata?.file_name ||
    imagePath ||
    'Generated image';
  const showImage =
    isRenderableImageUrl(imagePath) && previewImageUrl && !error;

  const handlePreview = useCallback(() => {
    if (!previewImageUrl || error) return;

    openImagePreview({
      imageUrl: previewImageUrl,
      altText: label,
      fileName: metadata?.file_name ?? label,
      format: metadata?.format ?? undefined,
      sizeBytes: metadata?.size_bytes,
    });
  }, [error, label, metadata, openImagePreview, previewImageUrl]);

  if (!toolEntry || !action) return null;

  return (
    <ToolCardShell
      icon={<ImageIcon className="h-3 w-3" />}
      label={t('generatedImages.label')}
      detail={detail}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded
      expandable={false}
    >
      <ToolArtifact badge={statusText} title={prompt || revisedPrompt}>
        {showImage ? (
          <button
            type="button"
            className="conv-generated-image-preview"
            onClick={handlePreview}
            aria-label={t('generatedImages.previewImage')}
            title={t('generatedImages.previewImage')}
          >
            <img
              src={previewImageUrl}
              alt={label}
              className="max-h-64 max-w-full rounded-md border border-border object-contain"
            />
          </button>
        ) : isLoading ? (
          <div className="conv-generated-image-placeholder">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : imagePath ? (
          <ToolProse className="font-mono">{imagePath}</ToolProse>
        ) : null}
        {revisedPrompt ? (
          <ToolProse>{revisedPrompt}</ToolProse>
        ) : prompt && showImage ? (
          <ToolProse>{prompt}</ToolProse>
        ) : null}
        {error ? <ToolProse>{error}</ToolProse> : null}
      </ToolArtifact>
    </ToolCardShell>
  );
}
