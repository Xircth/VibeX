import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { useOpenAttachmentPreview } from '@/hooks/useOpenAttachmentPreview';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import {
  blobSrcFromDataUrl,
  hostFileSrc,
  isDirectBrowserDisplayUrl,
  releaseHostFileSrc,
} from '@/lib/hostAsset';
import { cn } from '@/lib/utils';
import { AttachmentFileCard } from './attachments/AttachmentFileCard';
import { useDelayedHover } from './attachments/useDelayedHover';
import {
  loadUserMessageImageSrc,
  userMessageImageFilesystemCandidates,
  type UserMessageImage,
} from './userMessageImages';

function UserMessageImageAttachment({
  image,
  taskAttemptId,
  workspacePath,
  expanded = true,
  onMouseEnter,
  onMouseLeave,
}: {
  image: UserMessageImage;
  taskAttemptId?: string;
  workspacePath?: string | null;
  expanded?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const { data: metadata, isLoading } = useImageMetadata(
    taskAttemptId,
    image.path
  );
  const openAttachmentPreview = useOpenAttachmentPreview();
  const rawImageUrl = metadata?.proxy_url ?? image.sourceUrl ?? undefined;
  const directImageUrl = isDirectBrowserDisplayUrl(rawImageUrl)
    ? rawImageUrl
    : undefined;
  const [resolvedImageUrl, setResolvedImageUrl] = useState<string | null>(
    directImageUrl ?? null
  );
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const imageUrl = directImageUrl ?? resolvedImageUrl ?? undefined;
  const label = image.altText || metadata?.file_name || 'Image';
  const resolvedImagePath = metadata?.path ?? image.path;
  const filesystemAssetPaths = useMemo(
    () =>
      userMessageImageFilesystemCandidates({
        imagePath: image.path,
        metadataPath: metadata?.path,
        metadataProxyUrl: metadata?.proxy_url,
        workspacePath,
      }),
    [image.path, metadata?.path, metadata?.proxy_url, workspacePath]
  );

  useEffect(() => {
    setImageLoadFailed(false);
    if (directImageUrl) {
      setResolvedImageUrl(directImageUrl);
      return;
    }

    if (rawImageUrl?.startsWith('data:')) {
      const blobUrl = blobSrcFromDataUrl(rawImageUrl);
      setResolvedImageUrl(blobUrl ?? rawImageUrl);
      return () => {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      };
    }

    if (image.sourceUrl?.startsWith('data:')) {
      const blobUrl = blobSrcFromDataUrl(image.sourceUrl);
      setResolvedImageUrl(blobUrl ?? image.sourceUrl);
      return () => {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      };
    }

    // Wait for metadata: that call copies the cache file into the workspace
    // `.vibe-images` folder. Reading before the copy lands 404s the thumbnail.
    if (isLoading) {
      setResolvedImageUrl(null);
      return;
    }

    if (filesystemAssetPaths.length === 0) {
      setResolvedImageUrl(null);
      setImageLoadFailed(true);
      return;
    }

    let cancelled = false;
    let acquiredPath: string | null = null;
    void loadUserMessageImageSrc(filesystemAssetPaths, hostFileSrc).then(
      (loaded) => {
        if (cancelled) {
          if (loaded) releaseHostFileSrc(loaded.path);
          return;
        }
        if (!loaded) {
          setImageLoadFailed(true);
          return;
        }
        acquiredPath = loaded.path;
        setResolvedImageUrl(loaded.url);
      }
    );

    return () => {
      cancelled = true;
      if (acquiredPath) {
        releaseHostFileSrc(acquiredPath);
      }
    };
  }, [
    directImageUrl,
    filesystemAssetPaths,
    image.sourceUrl,
    isLoading,
    rawImageUrl,
  ]);

  const handleImageError = useCallback(() => {
    setImageLoadFailed(true);
  }, []);

  const handlePreview = useCallback(() => {
    if (!imageUrl || imageLoadFailed) return;

    openAttachmentPreview({
      kind: image.kind === 'video' ? 'video' : 'image',
      imageUrl,
      altText: label,
      fileName: metadata?.file_name ?? label,
      filePath: resolvedImagePath,
      format: metadata?.format ?? undefined,
      sizeBytes: metadata?.size_bytes,
    });
  }, [
    imageLoadFailed,
    imageUrl,
    label,
    metadata,
    image.kind,
    openAttachmentPreview,
    resolvedImagePath,
  ]);

  return (
    <button
      type="button"
      className={cn(
        'attachment-image-thumb relative flex items-center justify-center outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default'
      )}
      data-expanded={expanded ? 'true' : 'false'}
      onClick={handlePreview}
      disabled={!imageUrl || imageLoadFailed}
      aria-label="Preview image"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {imageUrl && !imageLoadFailed ? (
        image.kind === 'video' ? (
          <video
            src={imageUrl}
            muted
            playsInline
            preload="metadata"
            className="absolute inset-0 h-full w-full object-cover"
            onError={handleImageError}
          />
        ) : (
          <img
            src={imageUrl}
            alt={label}
            className="absolute inset-0 h-full w-full object-cover"
            onError={handleImageError}
          />
        )
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground">
          {isLoading || (!imageLoadFailed && resolvedImagePath) ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImageIcon className="h-5 w-5" />
          )}
        </span>
      )}
    </button>
  );
}

function UserMessageFileAttachment({
  file,
  taskAttemptId,
  expanded,
  onMouseEnter,
  onMouseLeave,
}: {
  file: UserMessageImage;
  taskAttemptId?: string;
  expanded: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const { data: metadata } = useImageMetadata(taskAttemptId, file.path);
  const openAttachmentPreview = useOpenAttachmentPreview();
  const name = metadata?.file_name || file.altText || file.path;
  const filePath = metadata?.path ?? file.path;

  const handlePreview = useCallback(() => {
    openAttachmentPreview({
      kind: 'file',
      fileName: name,
      filePath,
    });
  }, [filePath, name, openAttachmentPreview]);

  return (
    <AttachmentFileCard
      name={name}
      sizeBytes={metadata?.size_bytes}
      modifiedAt={metadata?.updated_at}
      expanded={expanded}
      onClick={handlePreview}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    />
  );
}

function FileAttachmentRow({
  files,
  taskAttemptId,
}: {
  files: UserMessageImage[];
  taskAttemptId?: string;
}) {
  const stacked = files.length > 1;
  const hover = useDelayedHover();

  return (
    <div
      className={stacked ? 'attachment-file-stack' : 'flex justify-end'}
      data-testid="user-message-file-attachments"
    >
      {files.map((file) => (
        <UserMessageFileAttachment
          key={file.id}
          file={file}
          taskAttemptId={taskAttemptId}
          expanded={!stacked || hover.activeId === file.id}
          onMouseEnter={stacked ? () => hover.enter(file.id) : undefined}
          onMouseLeave={stacked ? hover.leave : undefined}
        />
      ))}
    </div>
  );
}

function ImageAttachmentRow({
  images,
  taskAttemptId,
  workspacePath,
}: {
  images: UserMessageImage[];
  taskAttemptId?: string;
  workspacePath?: string | null;
}) {
  const stacked = images.length >= 4;
  const hover = useDelayedHover();

  return (
    <div
      className={
        stacked
          ? 'attachment-image-stack'
          : 'flex max-w-[min(520px,calc(100vw-4rem))] flex-wrap justify-end gap-2'
      }
      data-testid="user-message-image-attachments"
    >
      {images.map((image) => (
        <UserMessageImageAttachment
          key={image.id}
          image={image}
          taskAttemptId={taskAttemptId}
          workspacePath={workspacePath}
          expanded={!stacked || hover.activeId === image.id}
          onMouseEnter={stacked ? () => hover.enter(image.id) : undefined}
          onMouseLeave={stacked ? hover.leave : undefined}
        />
      ))}
    </div>
  );
}

export function UserMessageAttachments({
  images,
  files = [],
  taskAttemptId,
  workspacePath,
}: {
  images: UserMessageImage[];
  files?: UserMessageImage[];
  taskAttemptId?: string;
  workspacePath?: string | null;
}) {
  if (images.length === 0 && files.length === 0) return null;

  return (
    <div
      className="flex max-w-[min(520px,calc(100vw-4rem))] flex-col items-end gap-1.5"
      data-testid="user-message-attachments"
    >
      {files.length > 0 ? (
        <FileAttachmentRow files={files} taskAttemptId={taskAttemptId} />
      ) : null}
      {images.length > 0 ? (
        <ImageAttachmentRow
          images={images}
          taskAttemptId={taskAttemptId}
          workspacePath={workspacePath}
        />
      ) : null}
    </div>
  );
}
