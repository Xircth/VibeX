import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Image, Loader2, X } from 'lucide-react';
import type { SendMessageShortcut } from 'shared/types';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { fileTreeApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  clipboardDataHasTextPayload,
  extractImageFilesFromClipboardData,
  readImageFilesFromNavigatorClipboard,
} from '@/utils/clipboard';

export type SessionComposerImage = {
  id: string;
  name: string;
  path: string;
  previewUrl?: string;
};

type SessionComposerInputProps = {
  value: string;
  disabled?: boolean;
  className?: string;
  sendShortcut?: SendMessageShortcut;
  taskAttemptId?: string;
  taskId?: string;
  images: SessionComposerImage[];
  onChange: (value: string) => void;
  onSubmit: () => void;
  onAttachImages: (files: File[]) => void;
  onRemoveImage: (imageId: string) => void;
};

function imageFilesFromFileList(files: FileList | null | undefined): File[] {
  return Array.from(files ?? []).filter((file) =>
    file.type.startsWith('image/')
  );
}

function SessionComposerImageAttachment({
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
  const [fallbackImageUrl, setFallbackImageUrl] = useState<string | null>(null);
  const [previewUrlFailed, setPreviewUrlFailed] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const primaryImageUrl =
    image.previewUrl && !previewUrlFailed
      ? image.previewUrl
      : metadata?.proxy_url;
  const imageUrl = fallbackImageUrl ?? primaryImageUrl;
  const label = metadata?.file_name ?? image.name;

  useEffect(() => {
    setFallbackImageUrl(null);
    setImageLoadFailed(false);
  }, [primaryImageUrl]);

  useEffect(() => {
    setPreviewUrlFailed(false);
  }, [image.previewUrl]);

  const handlePreview = useCallback(() => {
    if (!imageUrl || imageLoadFailed) return;

    ImagePreviewDialog.show({
      imageUrl,
      altText: label,
      fileName: label,
      format: metadata?.format ?? undefined,
      sizeBytes: metadata?.size_bytes,
    });
  }, [imageLoadFailed, imageUrl, label, metadata]);

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
      setPreviewUrlFailed(true);
      return;
    }

    if (fallbackImageUrl || !metadata?.path) {
      setImageLoadFailed(true);
      return;
    }

    fileTreeApi
      .readBinaryAsset(metadata.path)
      .then((asset) => {
        setFallbackImageUrl(
          `data:${asset.mime_type};base64,${asset.data_base64}`
        );
      })
      .catch((error: unknown) => {
        console.warn('Failed to load composer image fallback:', error);
        setImageLoadFailed(true);
      });
  }, [fallbackImageUrl, image.previewUrl, imageUrl, metadata?.path]);

  return (
    <div
      className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted/40"
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
          <img
            src={imageUrl}
            alt={label}
            className="h-full w-full object-cover"
            onError={handleImageError}
          />
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

export function SessionComposerInput({
  value,
  disabled = false,
  className,
  sendShortcut = 'Enter',
  taskAttemptId,
  taskId,
  images,
  onChange,
  onSubmit,
  onAttachImages,
  onRemoveImage,
}: SessionComposerInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
  }, [value]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = extractImageFilesFromClipboardData(event.clipboardData);
      if (files.length > 0) {
        event.preventDefault();
        onAttachImages(files);
        return;
      }

      if (clipboardDataHasTextPayload(event.clipboardData)) {
        return;
      }

      event.preventDefault();
      readImageFilesFromNavigatorClipboard()
        .then((clipboardFiles) => {
          if (clipboardFiles.length > 0) {
            onAttachImages(clipboardFiles);
          }
        })
        .catch((error: unknown) => {
          console.warn('Failed to read image from clipboard:', error);
        });
    },
    [onAttachImages]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      const files = imageFilesFromFileList(event.dataTransfer.files);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      onAttachImages(files);
    },
    [onAttachImages]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (disabled || event.key !== 'Enter') {
        return;
      }

      const shouldSubmit =
        sendShortcut === 'Enter'
          ? !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
          : (event.metaKey || event.ctrlKey) && !event.shiftKey;

      if (!shouldSubmit) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onSubmit();
    },
    [disabled, onSubmit, sendShortcut]
  );

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-1">
          {images.map((image) => (
            <SessionComposerImageAttachment
              key={image.id}
              image={image}
              disabled={disabled}
              taskAttemptId={taskAttemptId}
              taskId={taskId}
              onRemoveImage={onRemoveImage}
            />
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        rows={1}
        className={cn(
          'min-h-[40px] max-h-[100px] resize-none overflow-y-auto bg-transparent px-1 py-1 text-[13px] leading-5 tracking-[0.005em] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60',
          className
        )}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(event) => event.preventDefault()}
      />
    </div>
  );
}
