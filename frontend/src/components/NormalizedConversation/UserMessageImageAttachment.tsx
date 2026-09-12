import { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, Loader2 } from 'lucide-react';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { fileTreeApi } from '@/lib/api';
import type { UserMessageImage } from './userMessageImages';

const MAX_USER_MESSAGE_IMAGE_URL_CACHE = 100;
const MAX_USER_MESSAGE_THUMBNAIL_CACHE = 100;
const USER_MESSAGE_THUMBNAIL_SIZE = 160;

const userMessageImageUrlCache = new Map<string, string>();
const userMessageImageUrlRequests = new Map<string, Promise<string>>();
const userMessageThumbnailCache = new Map<string, string>();
const userMessageThumbnailRequests = new Map<string, Promise<string | null>>();

function rememberUserMessageImageUrl(path: string, url: string) {
  if (!path) return;
  userMessageImageUrlCache.delete(path);
  userMessageImageUrlCache.set(path, url);

  while (userMessageImageUrlCache.size > MAX_USER_MESSAGE_IMAGE_URL_CACHE) {
    const oldestKey = userMessageImageUrlCache.keys().next().value;
    if (!oldestKey) break;
    userMessageImageUrlCache.delete(oldestKey);
  }
}

function getCachedUserMessageImageUrl(path: string): string | null {
  if (!path) return null;
  return userMessageImageUrlCache.get(path) ?? null;
}

function rememberUserMessageThumbnail(path: string, url: string) {
  if (!path) return;
  userMessageThumbnailCache.delete(path);
  userMessageThumbnailCache.set(path, url);

  while (userMessageThumbnailCache.size > MAX_USER_MESSAGE_THUMBNAIL_CACHE) {
    const oldestKey = userMessageThumbnailCache.keys().next().value;
    if (!oldestKey) break;
    userMessageThumbnailCache.delete(oldestKey);
  }
}

function getCachedUserMessageThumbnail(path: string): string | null {
  if (!path) return null;
  return userMessageThumbnailCache.get(path) ?? null;
}

function createImageThumbnail(sourceUrl: string): Promise<string | null> {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const image = new window.Image();
    image.decoding = 'async';

    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (width <= 0 || height <= 0) {
        resolve(null);
        return;
      }

      const scale = Math.min(
        1,
        USER_MESSAGE_THUMBNAIL_SIZE / Math.max(width, height)
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      const context = canvas.getContext('2d');
      if (!context) {
        resolve(null);
        return;
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      try {
        resolve(canvas.toDataURL('image/webp', 0.76));
      } catch {
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve(null);
        }
      }
    };

    image.onerror = () => resolve(null);
    image.src = sourceUrl;
  });
}

function ensureUserMessageThumbnail(path: string, sourceUrl: string) {
  const cached = getCachedUserMessageThumbnail(path);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = userMessageThumbnailRequests.get(path);
  if (pending) {
    return pending;
  }

  const request = createImageThumbnail(sourceUrl)
    .then((thumbnailUrl) => {
      if (thumbnailUrl) {
        rememberUserMessageThumbnail(path, thumbnailUrl);
      }

      return thumbnailUrl;
    })
    .finally(() => {
      userMessageThumbnailRequests.delete(path);
    });

  userMessageThumbnailRequests.set(path, request);
  return request;
}

async function ensureUserMessageThumbnailFromAsset(
  path: string,
  assetPath: string,
  sourceUrl: string
) {
  const directThumbnail = await ensureUserMessageThumbnail(path, sourceUrl);
  if (directThumbnail) {
    return directThumbnail;
  }

  const assetUrl = await readCachedUserMessageImageUrl(assetPath);
  return ensureUserMessageThumbnail(path, assetUrl);
}

function readCachedUserMessageImageUrl(path: string): Promise<string> {
  const cached = getCachedUserMessageImageUrl(path);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = userMessageImageUrlRequests.get(path);
  if (pending) {
    return pending;
  }

  const request = fileTreeApi
    .readBinaryAsset(path)
    .then((asset) => {
      const url = `data:${asset.mime_type};base64,${asset.data_base64}`;
      rememberUserMessageImageUrl(path, url);
      return url;
    })
    .finally(() => {
      userMessageImageUrlRequests.delete(path);
    });

  userMessageImageUrlRequests.set(path, request);
  return request;
}

function UserMessageImageAttachment({
  image,
  taskAttemptId,
}: {
  image: UserMessageImage;
  taskAttemptId?: string;
}) {
  const { data: metadata, isLoading } = useImageMetadata(
    taskAttemptId,
    image.path
  );
  const openImagePreview = useOpenImagePreview();
  const [cachedImageUrl, setCachedImageUrl] = useState<string | null>(() =>
    getCachedUserMessageImageUrl(image.path)
  );
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(() =>
    getCachedUserMessageThumbnail(image.path)
  );
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const imageUrl =
    cachedImageUrl ?? metadata?.proxy_url ?? image.sourceUrl ?? undefined;
  const displayImageUrl = thumbnailUrl ?? imageUrl;
  const label = image.altText || metadata?.file_name || 'Image';
  const resolvedImagePath = metadata?.path ?? image.path;

  useEffect(() => {
    setCachedImageUrl(getCachedUserMessageImageUrl(image.path));
    setThumbnailUrl(getCachedUserMessageThumbnail(image.path));
    setImageLoadFailed(false);
  }, [image.path]);

  useEffect(() => {
    if (!imageUrl || thumbnailUrl) return;

    let cancelled = false;
    ensureUserMessageThumbnailFromAsset(image.path, resolvedImagePath, imageUrl)
      .then((nextThumbnailUrl) => {
        if (!cancelled && nextThumbnailUrl) {
          setThumbnailUrl(nextThumbnailUrl);
        }
      })
      .catch(() => {
        // A failed thumbnail conversion should not block the full image.
      });

    return () => {
      cancelled = true;
    };
  }, [image.path, imageUrl, resolvedImagePath, thumbnailUrl]);

  const handleImageError = useCallback(() => {
    if (cachedImageUrl && imageUrl === cachedImageUrl) {
      setImageLoadFailed(true);
      return;
    }

    if (!resolvedImagePath) {
      setImageLoadFailed(true);
      return;
    }

    readCachedUserMessageImageUrl(resolvedImagePath)
      .then((asset) => {
        setCachedImageUrl(asset);
        return ensureUserMessageThumbnail(image.path, asset);
      })
      .then((nextThumbnailUrl) => {
        if (nextThumbnailUrl) {
          setThumbnailUrl(nextThumbnailUrl);
        }
      })
      .catch((error: unknown) => {
        console.warn('Failed to load user message image fallback:', error);
        setImageLoadFailed(true);
      });
  }, [cachedImageUrl, image.path, imageUrl, resolvedImagePath]);

  const handleImageLoad = useCallback(() => {
    if (!imageUrl) return;
    rememberUserMessageImageUrl(image.path, imageUrl);
  }, [image.path, imageUrl]);

  const handlePreview = useCallback(() => {
    if (!imageUrl || imageLoadFailed) return;

    openImagePreview({
      imageUrl,
      altText: label,
      fileName: metadata?.file_name ?? label,
      format: metadata?.format ?? undefined,
      sizeBytes: metadata?.size_bytes,
    });
  }, [imageLoadFailed, imageUrl, label, metadata, openImagePreview]);

  return (
    <button
      type="button"
      className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-background/30 shadow-sm outline-none transition hover:border-white/25 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default"
      onClick={handlePreview}
      disabled={!imageUrl || imageLoadFailed}
      aria-label="Preview image"
    >
      {displayImageUrl && !imageLoadFailed ? (
        <img
          src={displayImageUrl}
          alt={label}
          className="h-full w-full object-cover"
          onLoad={handleImageLoad}
          onError={handleImageError}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-muted-foreground">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImageIcon className="h-5 w-5" />
          )}
        </span>
      )}
    </button>
  );
}

export function UserMessageAttachments({
  images,
  taskAttemptId,
}: {
  images: UserMessageImage[];
  taskAttemptId?: string;
}) {
  if (images.length === 0) return null;

  return (
    <div
      className="flex max-w-[min(520px,calc(100vw-4rem))] flex-wrap justify-end gap-2"
      data-testid="user-message-attachments"
    >
      {images.map((image) => (
        <UserMessageImageAttachment
          key={image.id}
          image={image}
          taskAttemptId={taskAttemptId}
        />
      ))}
    </div>
  );
}
