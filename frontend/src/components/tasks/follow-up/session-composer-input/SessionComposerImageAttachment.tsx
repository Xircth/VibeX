import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { Image, Loader2, X } from 'lucide-react';

import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import {
  hostFileSrc,
  isBrowserDisplayUrl,
  releaseHostFileSrc,
} from '@/lib/hostAsset';

import { AttachmentFileCard } from '@/components/NormalizedConversation/attachments/AttachmentFileCard';
import { attachmentPreviewKind, fileExtension } from '@/utils/mediaAttachments';

import type { SessionComposerImage } from './sessionComposerTypes';

export function SessionComposerImageAttachment({
  image,
  disabled,
  taskAttemptId,
  taskId,
  onRemoveImage,
}: {
  image: SessionComposerImage;
  disabled: boolean;
  taskAttemptId?: string;
  taskId?: string;
  onRemoveImage: (imageId: string) => void;
}) {
  const { data: metadata, isLoading } = useImageMetadata(
    taskAttemptId,
    image.path,
    taskId
  );
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const previewUrlFailed =
    image.previewUrl != null && failedPreviewUrl === image.previewUrl;
  const [fallbackByUrl, setFallbackByUrl] = useState<{
    forUrl: string | null | undefined;
    url: string | null;
    loadFailed: boolean;
  }>({ forUrl: undefined, url: null, loadFailed: false });
  const primaryImageUrl =
    image.previewUrl && !previewUrlFailed
      ? image.previewUrl
      : metadata?.proxy_url;
  const fallbackImageUrl =
    fallbackByUrl.forUrl === primaryImageUrl ? fallbackByUrl.url : null;
  const imageLoadFailed =
    fallbackByUrl.forUrl === primaryImageUrl && fallbackByUrl.loadFailed;
  const rawImageUrl = fallbackImageUrl ?? primaryImageUrl;
  const imageUrl = isBrowserDisplayUrl(rawImageUrl) ? rawImageUrl : undefined;
  const label = metadata?.file_name ?? image.name;
  const previewKind = attachmentPreviewKind(
    image.name || metadata?.file_name || '',
    metadata?.format
  );
  const openImagePreview = useOpenImagePreview();

  useEffect(() => {
    if (previewKind === 'file' || imageUrl || isLoading || !metadata?.path) {
      return;
    }

    const assetPath = metadata.path;
    const forUrl = primaryImageUrl;
    let cancelled = false;
    let acquiredPath: string | null = null;
    hostFileSrc(assetPath)
      .then((url) => {
        if (cancelled) {
          releaseHostFileSrc(assetPath);
          return;
        }
        acquiredPath = assetPath;
        setFallbackByUrl({ forUrl, url, loadFailed: false });
      })
      .catch((error: unknown) => {
        console.warn('Failed to load composer image fallback:', error);
        if (!cancelled) {
          setFallbackByUrl({ forUrl, url: null, loadFailed: true });
        }
      });

    return () => {
      cancelled = true;
      if (acquiredPath) {
        releaseHostFileSrc(acquiredPath);
      }
    };
  }, [imageUrl, isLoading, metadata?.path, previewKind, primaryImageUrl]);

  const handlePreview = useCallback(() => {
    if (previewKind === 'file' || !imageUrl || imageLoadFailed) return;

    openImagePreview({
      imageUrl,
      altText: label,
      fileName: label,
      format: metadata?.format ?? fileExtension(image.name) ?? undefined,
      sizeBytes: metadata?.size_bytes,
    });
  }, [
    imageLoadFailed,
    imageUrl,
    image.name,
    label,
    metadata,
    openImagePreview,
    previewKind,
  ]);

  const handleRemove = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onRemoveImage(image.id);
    },
    [image.id, onRemoveImage]
  );

  const handleImageError = useCallback(() => {
    if (image.previewUrl && imageUrl === image.previewUrl) {
      setFailedPreviewUrl(image.previewUrl);
      return;
    }

    setFallbackByUrl({
      forUrl: primaryImageUrl,
      url: null,
      loadFailed: true,
    });
  }, [image.previewUrl, imageUrl, primaryImageUrl]);

  if (previewKind === 'file') {
    return (
      <div
        className="group relative max-w-full shrink-0"
        data-testid="session-composer-file-attachment"
      >
        <AttachmentFileCard
          name={label}
          sizeBytes={metadata?.size_bytes}
          modifiedAt={metadata?.updated_at}
        />
        <button
          type="button"
          className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
          onClick={handleRemove}
          disabled={disabled}
          aria-label={`Remove ${label}`}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted/40"
      title={label}
    >
      <button
        type="button"
        className="flex h-full w-full items-center justify-center overflow-hidden outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default"
        onClick={handlePreview}
        disabled={!imageUrl || imageLoadFailed}
        aria-label={`Preview ${label}`}
      >
        {imageUrl && !imageLoadFailed ? (
          previewKind === 'video' ? (
            <video
              src={imageUrl}
              muted
              playsInline
              preload="metadata"
              className="h-full w-full object-cover"
              data-testid="session-composer-video-attachment"
              onError={handleImageError}
            />
          ) : (
            <img
              src={imageUrl}
              alt={label}
              className="h-full w-full object-cover"
              onError={handleImageError}
            />
          )
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted-foreground">
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Image className="h-5 w-5" />
            )}
          </span>
        )}
      </button>
      <button
        type="button"
        className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-60"
        onClick={handleRemove}
        disabled={disabled}
        aria-label={`Remove ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
