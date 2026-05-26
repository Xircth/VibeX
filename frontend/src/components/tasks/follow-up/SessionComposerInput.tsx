import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Image, Loader2, X } from 'lucide-react';
import type {
  ExecutorProfileId,
  SendMessageShortcut,
} from 'shared/types';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { TypeaheadMenu } from '@/components/ui/wysiwyg/plugins/typeahead-menu-components';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { fileTreeApi, repoApi, skillsApi } from '@/lib/api';
import {
  DOLLAR_COMMANDS,
  mergeDollarCommands,
  skillsToDollarCommands,
} from '@/lib/dollarCommands';
import { searchTagsAndFiles } from '@/lib/searchTagsAndFiles';
import { cn } from '@/lib/utils';
import {
  clipboardDataHasTextPayload,
  extractImageFilesFromClipboardData,
  readImageFilesFromNavigatorClipboard,
} from '@/utils/clipboard';
import {
  getTextareaTypeaheadState,
  replaceTextareaTypeaheadRange,
  type TextareaTypeaheadState,
} from './sessionComposerTypeahead';
import {
  dollarCommandsToTypeaheadOptions,
  referenceResultsToTypeaheadOptions,
  rootEntriesToFileReferenceOptions,
  slashCommandsToTypeaheadOptions,
  type ComposerTypeaheadOption,
} from './sessionComposerTypeaheadOptions';

export type SessionComposerImage = {
  id: string;
  name: string;
  path: string;
  previewUrl?: string;
};

export type SessionComposerInputContext = {
  sendShortcut?: SendMessageShortcut;
  taskAttemptId?: string;
  taskId?: string;
  workspaceId?: string;
  repoId?: string;
  repoIds?: string[];
  projectId?: string;
  executorProfile?: ExecutorProfileId | null;
};

type SessionComposerInputProps = {
  value: string;
  disabled?: boolean;
  className?: string;
  context?: SessionComposerInputContext;
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
  context,
  images,
  onChange,
  onSubmit,
  onAttachImages,
  onRemoveImage,
}: SessionComposerInputProps) {
  const {
    sendShortcut = 'Enter',
    taskAttemptId,
    taskId,
    workspaceId,
    repoId,
    repoIds,
    projectId,
    executorProfile,
  } = context ?? {};
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const blurTimerRef = useRef<number | null>(null);
  const [typeaheadState, setTypeaheadState] =
    useState<TextareaTypeaheadState | null>(null);
  const [selectedTypeaheadIndex, setSelectedTypeaheadIndex] = useState(0);
  const typeaheadTrigger = typeaheadState?.trigger ?? null;
  const typeaheadQuery = typeaheadState?.match.matchingString ?? '';
  const executor = executorProfile?.executor ?? null;
  const effectiveRepoIds = useMemo(() => {
    const ids = repoIds?.filter(Boolean) ?? [];
    if (ids.length > 0) return ids;
    return repoId ? [repoId] : [];
  }, [repoId, repoIds]);
  const primaryRepoId = effectiveRepoIds[0] ?? null;

  const slashCommandsQuery = useSlashCommands(executorProfile, {
    workspaceId,
    repoId,
  });
  const allSlashCommands = useMemo(
    () => slashCommandsQuery.commands ?? [],
    [slashCommandsQuery.commands]
  );
  const { data: localSkills = [] } = useQuery({
    queryKey: ['local-agent-skills', 'CODEX'],
    queryFn: () => skillsApi.listLocal('CODEX'),
    enabled: typeaheadTrigger === '$',
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
  const allDollarCommands = useMemo(
    () =>
      mergeDollarCommands(DOLLAR_COMMANDS, skillsToDollarCommands(localSkills)),
    [localSkills]
  );
  const { data: initialRepo } = useQuery({
    queryKey: ['session-composer-file-typeahead-repo', primaryRepoId],
    queryFn: async () =>
      primaryRepoId ? repoApi.getById(primaryRepoId) : null,
    enabled: typeaheadTrigger === '@' && !!primaryRepoId,
  });
  const { data: initialRootEntries, isLoading: isInitialRootEntriesLoading } =
    useQuery({
      queryKey: ['session-composer-file-typeahead-root', initialRepo?.path],
      queryFn: () => fileTreeApi.listDirectoryChildren(initialRepo!.path, ''),
      enabled:
        typeaheadTrigger === '@' &&
        typeaheadQuery.trim() === '' &&
        !!initialRepo?.path,
    });
  const shouldSearchReferences =
    (typeaheadTrigger === '#' ||
      (typeaheadTrigger === '@' && typeaheadQuery.trim().length > 0)) &&
    (effectiveRepoIds.length > 0 || !!projectId || typeaheadTrigger === '#');
  const { data: referenceResults = [], isFetching: isSearchingReferences } =
    useQuery({
      queryKey: [
        'session-composer-reference-typeahead',
        typeaheadTrigger,
        typeaheadQuery.trim(),
        effectiveRepoIds,
        projectId,
      ],
      queryFn: () =>
        searchTagsAndFiles(typeaheadQuery.trim(), {
          repoIds: effectiveRepoIds,
          projectId,
          includeTags: typeaheadTrigger === '#',
          includeFiles: typeaheadTrigger === '@',
        }),
      enabled: shouldSearchReferences,
      staleTime: 5_000,
    });

  const typeaheadOptions = useMemo((): ComposerTypeaheadOption[] => {
    if (!typeaheadState) return [];

    if (typeaheadState.trigger === '/') {
      return slashCommandsToTypeaheadOptions(
        allSlashCommands,
        typeaheadQuery,
        executor
      );
    }

    if (typeaheadState.trigger === '$') {
      return dollarCommandsToTypeaheadOptions(
        allDollarCommands,
        typeaheadQuery
      );
    }

    if (typeaheadState.trigger === '@' && typeaheadQuery.trim() === '') {
      if (!initialRootEntries) return [];
      return rootEntriesToFileReferenceOptions(initialRootEntries);
    }

    if (typeaheadState.trigger === '@' || typeaheadState.trigger === '#') {
      return referenceResultsToTypeaheadOptions(
        typeaheadState.trigger,
        referenceResults
      );
    }

    return [];
  }, [
    allDollarCommands,
    allSlashCommands,
    executor,
    initialRootEntries,
    referenceResults,
    typeaheadQuery,
    typeaheadState,
  ]);
  const isTypeaheadLoading =
    (typeaheadTrigger === '/' &&
      !!executorProfile?.executor &&
      !slashCommandsQuery.isInitialized) ||
    (typeaheadTrigger === '@' &&
      typeaheadQuery.trim() === '' &&
      !!primaryRepoId &&
      isInitialRootEntriesLoading) ||
    ((typeaheadTrigger === '@' || typeaheadTrigger === '#') &&
      isSearchingReferences);
  const shouldShowTypeahead =
    !!typeaheadState &&
    (typeaheadOptions.length > 0 ||
      isTypeaheadLoading ||
      typeaheadTrigger === '$' ||
      typeaheadTrigger === '@' ||
      typeaheadTrigger === '#' ||
      (typeaheadTrigger === '/' && !!executor));
  const typeaheadEmptyText = useMemo(() => {
    if (isTypeaheadLoading) {
      if (typeaheadTrigger === '@') return 'Searching files...';
      if (typeaheadTrigger === '#') return 'Searching tags...';
      return 'Loading commands...';
    }

    if (typeaheadTrigger === '@') return 'No matching files found.';
    if (typeaheadTrigger === '#') return 'No matching tags found.';
    return 'No matching commands found.';
  }, [isTypeaheadLoading, typeaheadTrigger]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
  }, [value]);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setSelectedTypeaheadIndex(0);
  }, [typeaheadState?.trigger, typeaheadState?.match.matchingString]);

  useEffect(() => {
    if (typeaheadOptions.length === 0) {
      setSelectedTypeaheadIndex(0);
      return;
    }

    setSelectedTypeaheadIndex((current) =>
      Math.min(current, typeaheadOptions.length - 1)
    );
  }, [typeaheadOptions.length]);

  const syncTypeaheadFromTextarea = useCallback(
    (nextValue?: string) => {
      const textarea = textareaRef.current;
      if (!textarea || disabled) {
        setTypeaheadState(null);
        return;
      }

      const currentValue = nextValue ?? textarea.value;
      const caretOffset = textarea.selectionStart ?? currentValue.length;
      setTypeaheadState(getTextareaTypeaheadState(currentValue, caretOffset));
    },
    [disabled]
  );

  const closeTypeahead = useCallback(() => {
    setTypeaheadState(null);
    setSelectedTypeaheadIndex(0);
  }, []);

  const commitTypeaheadOption = useCallback(
    (option: ComposerTypeaheadOption) => {
      if (!typeaheadState) return;

      const next = replaceTextareaTypeaheadRange(
        value,
        typeaheadState.match,
        option.insertText
      );
      onChange(next.value);
      closeTypeahead();

      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(next.caretOffset, next.caretOffset);
      });
    },
    [closeTypeahead, onChange, typeaheadState, value]
  );

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
      if (typeaheadState) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();
          setSelectedTypeaheadIndex((current) =>
            typeaheadOptions.length === 0
              ? 0
              : (current + 1) % typeaheadOptions.length
          );
          return;
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          setSelectedTypeaheadIndex((current) =>
            typeaheadOptions.length === 0
              ? 0
              : (current - 1 + typeaheadOptions.length) %
                typeaheadOptions.length
          );
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeTypeahead();
          return;
        }

        if (event.key === 'Tab' || event.key === 'Enter') {
          if (typeaheadOptions.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            commitTypeaheadOption(typeaheadOptions[selectedTypeaheadIndex]);
            return;
          }

          if (isTypeaheadLoading) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
      }

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
    [
      closeTypeahead,
      commitTypeaheadOption,
      disabled,
      isTypeaheadLoading,
      onSubmit,
      selectedTypeaheadIndex,
      sendShortcut,
      typeaheadOptions,
      typeaheadState,
    ]
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
        onChange={(event) => {
          onChange(event.target.value);
          syncTypeaheadFromTextarea(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={() => syncTypeaheadFromTextarea()}
        onClick={() => syncTypeaheadFromTextarea()}
        onSelect={() => syncTypeaheadFromTextarea()}
        onFocus={() => {
          if (blurTimerRef.current !== null) {
            window.clearTimeout(blurTimerRef.current);
            blurTimerRef.current = null;
          }
          syncTypeaheadFromTextarea();
        }}
        onBlur={() => {
          blurTimerRef.current = window.setTimeout(() => {
            closeTypeahead();
          }, 120);
        }}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(event) => event.preventDefault()}
      />
      {shouldShowTypeahead && textareaRef.current
        ? createPortal(
            <TypeaheadMenu anchorEl={textareaRef.current}>
              {typeaheadOptions.length > 0 ? (
                <TypeaheadMenu.ScrollArea>
                  {typeaheadOptions.map((option, index) => (
                    <TypeaheadMenu.Item
                      key={option.key}
                      isSelected={index === selectedTypeaheadIndex}
                      index={index}
                      setHighlightedIndex={setSelectedTypeaheadIndex}
                      onClick={() => commitTypeaheadOption(option)}
                    >
                      <div className="truncate font-medium">{option.label}</div>
                      {option.description ? (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {option.description}
                        </div>
                      ) : null}
                    </TypeaheadMenu.Item>
                  ))}
                </TypeaheadMenu.ScrollArea>
              ) : (
                <TypeaheadMenu.Empty>{typeaheadEmptyText}</TypeaheadMenu.Empty>
              )}
            </TypeaheadMenu>,
            document.body
          )
        : null}
    </div>
  );
}
