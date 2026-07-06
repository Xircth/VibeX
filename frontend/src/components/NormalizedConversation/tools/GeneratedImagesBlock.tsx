import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageIcon, Loader2 } from 'lucide-react';
import type { JsonValue, NormalizedEntry } from 'shared/types';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { renderJson } from '../conversation-entry-utils';
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
  const mimeType =
    readString(value, ['mime_type', 'mimeType']) || 'image/png';

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
  const showImage = isRenderableImageUrl(imagePath) && previewImageUrl && !error;

  const handlePreview = useCallback(() => {
    if (!previewImageUrl || error) return;

    ImagePreviewDialog.show({
      imageUrl: previewImageUrl,
      altText: label,
      fileName: metadata?.file_name ?? label,
      format: metadata?.format ?? undefined,
      sizeBytes: metadata?.size_bytes,
    });
  }, [error, label, metadata, previewImageUrl]);

  if (!toolEntry || !action) return null;

  return (
    <ToolCardShell
      icon={<ImageIcon className="h-3 w-3" />}
      label={t('generatedImages.label')}
      detail={detail}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      expanded
      expandable={false}
    >
      <div className="space-y-2 font-sans">
        <div>
          <div className="conv-tool-details-section-label">
            {t('generatedImages.status')}
          </div>
          <div className="conv-tool-details-content">{statusText}</div>
        </div>
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
          <div className="conv-tool-details-content font-mono">{imagePath}</div>
        ) : null}
        {prompt ? (
          <div>
            <div className="conv-tool-details-section-label">
              {t('generatedImages.prompt')}
            </div>
            <div className="conv-tool-details-content">{prompt}</div>
          </div>
        ) : null}
        {revisedPrompt ? (
          <div>
            <div className="conv-tool-details-section-label">
              {t('generatedImages.revisedPrompt')}
            </div>
            <div className="conv-tool-details-content">{revisedPrompt}</div>
          </div>
        ) : null}
        {error ? (
          <div>
            <div className="conv-tool-details-section-label">
              {t('generatedImages.error')}
            </div>
            <div className="conv-tool-details-content">{error}</div>
          </div>
        ) : null}
        {action.result ? (
          <div>
            <div className="conv-tool-details-section-label">
              {t('generatedImages.rawResult')}
            </div>
            <div className="conv-tool-details-content">
              {renderJson(action.result.value)}
            </div>
          </div>
        ) : null}
      </div>
    </ToolCardShell>
  );
}
