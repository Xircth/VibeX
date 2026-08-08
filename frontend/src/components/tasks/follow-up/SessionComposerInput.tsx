import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { Image, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExecutorProfileId, SendMessageShortcut } from 'shared/types';
import {
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerToken,
  type ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import type { SearchableItem, SearchSource } from '@astryxdesign/core/Typeahead';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import {
  fileTreeApi,
  repoApi,
  skillsApi,
  type AgentSkillsListResult,
} from '@/lib/api';
import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';
import { createPluginApi } from '@/lib/api/plugins';
import { DOLLAR_COMMANDS, mergeDollarCommands } from '@/lib/dollarCommands';
import {
  agentAvailableCommandsToSlashCommands,
  localSkillsToDollarCommands,
  localSkillsToSlashCommands,
  mergeComposerSlashCommands,
} from '@/lib/conversation-rendering/commandSources';
import { searchTagsAndFiles } from '@/lib/searchTagsAndFiles';
import { cn } from '@/lib/utils';
import { useComposerSelectionStore } from '@/stores/useComposerSelectionStore';
import { formatFileRangeRef } from '@/utils/codeSelection';
import {
  FILE_REFERENCE_DRAG_MIME,
  parseFileReferencePayload,
  type FileReferencePayload,
} from '@/utils/fileReferences';
import type { AgentAvailableCommand } from '@/features/agents/types';
import {
  clearCurrentDraggedFileReference,
  getCurrentDraggedFileReference,
} from '@/utils/fileReferenceDrag';
import {
  agentMentionsToTypeaheadOptions,
  dollarCommandsToTypeaheadOptions,
  pluginActionsToTypeaheadOptions,
  referenceResultsToTypeaheadOptions,
  rootEntriesToFileReferenceOptions,
  slashCommandsToTypeaheadOptions,
  type ComposerTypeaheadOption,
} from './sessionComposerTypeaheadOptions';
import { formatSessionComposerCommand } from './sessionComposerStructuredTokens';
import { useAgentMentions } from './AgentMention';

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
  sessionId?: string;
  workspaceId?: string;
  repoId?: string;
  repoIds?: string[];
  projectId?: string;
  executorProfile?: ExecutorProfileId | null;
  availableCommands?: AgentAvailableCommand[];
  transport?: BackendTransport;
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

function getDroppedFileReference(
  dataTransfer: DataTransfer
): FileReferencePayload | null {
  const serializedPayload = dataTransfer.getData(FILE_REFERENCE_DRAG_MIME);
  return (
    parseFileReferencePayload(serializedPayload) ??
    getCurrentDraggedFileReference()
  );
}

function hasFileReferenceDrag(dataTransfer: DataTransfer): boolean {
  return (
    Array.from(dataTransfer.types).includes(FILE_REFERENCE_DRAG_MIME) ||
    Boolean(getCurrentDraggedFileReference())
  );
}

function getFileName(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
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

/** Wrap a composer option as a SearchableItem, keeping its insert text. */
function toSearchableItem(
  option: ComposerTypeaheadOption
): SearchableItem {
  return {
    id: option.key,
    label: option.label,
    auxiliaryData: {
      insertText: option.insertText,
      description: option.description,
    },
  };
}

/** File-reference token text for a relative path (matches the legacy `@` syntax). */
function fileReferenceTokenText(relativePath: string): string {
  return formatSessionComposerCommand({
    type: '@',
    key: getFileName(relativePath),
    value: relativePath,
  });
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
  const { t } = useTranslation('tasks');
  const {
    sendShortcut = 'Enter',
    taskAttemptId,
    taskId,
    workspaceId,
    repoId,
    repoIds,
    projectId,
    executorProfile,
    availableCommands = [],
    transport = configuredBackendTransport,
  } = context ?? {};
  const composerHandleRef = useRef<ChatComposerInputHandle | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const agentMentions = useAgentMentions();
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
  const pluginApi = useMemo(() => createPluginApi(transport), [transport]);
  const { data: pluginCatalog } = useQuery({
    queryKey: ['session-composer-plugin-actions', transport.environment],
    queryFn: () => pluginApi.catalog(),
    staleTime: 5_000,
  });
  const { data: pluginAgentSkills } = useQuery({
    queryKey: [
      'session-composer-plugin-agent-skills',
      transport.environment,
      executor,
    ],
    queryFn: () =>
      transport.call('list_agent_skills', {
        agentType: executor!,
        workspacePath: null,
      }) as Promise<AgentSkillsListResult>,
    enabled: !!executor,
    staleTime: 0,
  });
  const hostedPluginSkillIds = useMemo(
    () => new Set(pluginAgentSkills?.skills.map((skill) => skill.id) ?? []),
    [pluginAgentSkills]
  );
  const { data: localSkills = [] } = useQuery({
    queryKey: ['local-agent-skills', 'codex'],
    queryFn: () => skillsApi.listLocal('codex'),
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
  });
  const allSlashCommands = useMemo(
    () =>
      mergeComposerSlashCommands({
        catalogCommands: slashCommandsQuery.commands ?? [],
        runtimeCommands:
          agentAvailableCommandsToSlashCommands(availableCommands),
        skillCommands: localSkillsToSlashCommands(localSkills),
      }),
    [availableCommands, localSkills, slashCommandsQuery.commands]
  );
  const allDollarCommands = useMemo(
    () =>
      mergeDollarCommands(
        DOLLAR_COMMANDS,
        localSkillsToDollarCommands(localSkills)
      ),
    [localSkills]
  );

  // --- Trigger search sources (adapted to the Astryx SearchSource contract) ---

  const slashSource = useMemo<SearchSource>(
    () => ({
      search: (query) =>
        slashCommandsToTypeaheadOptions(allSlashCommands, query, executor).map(
          toSearchableItem
        ),
      bootstrap: () =>
        slashCommandsToTypeaheadOptions(allSlashCommands, '', executor).map(
          toSearchableItem
        ),
    }),
    [allSlashCommands, executor]
  );
  const dollarSource = useMemo<SearchSource>(
    () => ({
      search: (query) =>
        dollarCommandsToTypeaheadOptions(allDollarCommands, query).map(
          toSearchableItem
        ),
      bootstrap: () =>
        dollarCommandsToTypeaheadOptions(allDollarCommands, '').map(
          toSearchableItem
        ),
    }),
    [allDollarCommands]
  );
  const agentMentionSource = useMemo<SearchSource>(
    () => ({
      search: (query) =>
        agentMentionsToTypeaheadOptions(agentMentions.candidates, query).map(
          toSearchableItem
        ),
      bootstrap: () =>
        agentMentionsToTypeaheadOptions(agentMentions.candidates, '').map(
          toSearchableItem
        ),
    }),
    [agentMentions.candidates]
  );
  const pluginSource = useMemo<SearchSource>(
    () => ({
      search: (query) =>
        pluginActionsToTypeaheadOptions(
          pluginCatalog,
          query,
          hostedPluginSkillIds
        ).map(toSearchableItem),
      bootstrap: () =>
        pluginActionsToTypeaheadOptions(
          pluginCatalog,
          '',
          hostedPluginSkillIds
        ).map(toSearchableItem),
    }),
    [hostedPluginSkillIds, pluginCatalog]
  );
  const fileReferenceSource = useMemo<SearchSource>(
    () => ({
      search: async (query) => {
        const trimmed = query.trim();
        if (trimmed === '') {
          if (!primaryRepoId) return [];
          const repo = await repoApi.getById(primaryRepoId);
          if (!repo) return [];
          const entries = await fileTreeApi.listDirectoryChildren(repo.path, '');
          return rootEntriesToFileReferenceOptions(entries).map(
            toSearchableItem
          );
        }
        const results = await searchTagsAndFiles(trimmed, {
          repoIds: effectiveRepoIds,
          projectId,
          includeTags: false,
          includeFiles: true,
        });
        return referenceResultsToTypeaheadOptions('@', results).map(
          toSearchableItem
        );
      },
      bootstrap: () => [],
    }),
    [effectiveRepoIds, primaryRepoId, projectId]
  );
  const tagReferenceSource = useMemo<SearchSource>(
    () => ({
      search: async (query) => {
        const results = await searchTagsAndFiles(query.trim(), {
          repoIds: effectiveRepoIds,
          projectId,
          includeTags: true,
          includeFiles: false,
        });
        return referenceResultsToTypeaheadOptions('#', results).map(
          toSearchableItem
        );
      },
      bootstrap: () => [],
    }),
    [effectiveRepoIds, projectId]
  );

  const makeToken = useCallback(
    (item: SearchableItem): ChatComposerToken => {
      const insertText =
        (item.auxiliaryData as { insertText?: string } | undefined)
          ?.insertText ?? '';
      return {
        value: insertText,
        label: item.label,
      };
    },
    []
  );
  const pluginOnSelect = useCallback((item: SearchableItem): string => {
    const insertText =
      (item.auxiliaryData as { insertText?: string } | undefined)
        ?.insertText ?? '';
    return insertText;
  }, []);

  const renderItem = useCallback(
    (item: SearchableItem) => {
      const description = (item.auxiliaryData as
        | { description?: string }
        | undefined)?.description;
      return (
        <div>
          <div className="truncate font-medium">{item.label}</div>
          {description ? (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
      );
    },
    []
  );

  const triggers = useMemo<ChatComposerTrigger[]>(
    () => [
      {
        character: '/',
        searchSource: slashSource,
        onSelect: makeToken,
        renderItem,
        loadingText: 'Loading commands...',
        emptySearchResultsText: 'No matching commands found.',
      },
      {
        character: '$',
        searchSource: dollarSource,
        onSelect: makeToken,
        renderItem,
        loadingText: 'Loading commands...',
        emptySearchResultsText: 'No matching commands found.',
      },
      {
        character: '&',
        searchSource: agentMentionSource,
        onSelect: makeToken,
        renderItem,
        loadingText: t('agentMention.loading'),
        emptySearchResultsText: t('agentMention.noMatches'),
      },
      {
        character: '!',
        searchSource: pluginSource,
        onSelect: pluginOnSelect,
        renderItem,
        loadingText: t('pluginActions.loading'),
        emptySearchResultsText: t('pluginActions.noMatches'),
      },
      {
        character: '@',
        searchSource: fileReferenceSource,
        onSelect: makeToken,
        renderItem,
        loadingText: 'Searching files...',
        emptySearchResultsText: 'No matching files found.',
      },
      {
        character: '#',
        searchSource: tagReferenceSource,
        onSelect: makeToken,
        renderItem,
        loadingText: 'Searching tags...',
        emptySearchResultsText: 'No matching tags found.',
      },
    ],
    [
      agentMentionSource,
      dollarSource,
      fileReferenceSource,
      makeToken,
      pluginOnSelect,
      pluginSource,
      renderItem,
      slashSource,
      t,
      tagReferenceSource,
    ]
  );

  // --- Keyboard: send shortcut (Astryx owns trigger-menu navigation) ---

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled || event.key !== 'Enter') return;
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;

      const shouldSubmit =
        sendShortcut === 'Enter'
          ? !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
          : (event.metaKey || event.ctrlKey) && !event.shiftKey;

      event.preventDefault();
      if (shouldSubmit) {
        onSubmit();
      } else {
        const handle = composerHandleRef.current;
        handle?.insertText('\n');
        if (handle) onChange(handle.getValue());
      }
    },
    [disabled, onChange, onSubmit, sendShortcut]
  );

  // --- Programmatic token insertion (code selection, file-reference drop) ---

  const insertFileReferenceTokenAtCaret = useCallback(
    (relativePath: string) => {
      const handle = composerHandleRef.current;
      if (!handle) return;
      handle.insertToken({
        value: fileReferenceTokenText(relativePath),
        label: `@${getFileName(relativePath)}`,
      });
      onChange(handle.getValue());
    },
    [onChange]
  );

  // P2-4: consume a code selection requested from a file viewer, inserting a
  // `@path:start-end` reference at the caret (or end of input).
  const pendingComposerSelection = useComposerSelectionStore((s) => s.pending);
  const consumeComposerSelection = useComposerSelectionStore((s) => s.consume);
  useEffect(() => {
    if (!pendingComposerSelection || disabled) return;
    const consumed = consumeComposerSelection();
    if (!consumed) return;
    insertFileReferenceTokenAtCaret(
      formatFileRangeRef(
        consumed.filePath,
        consumed.startLine,
        consumed.endLine
      )
    );
    window.requestAnimationFrame(() => composerHandleRef.current?.focus());
  }, [
    consumeComposerSelection,
    disabled,
    insertFileReferenceTokenAtCaret,
    pendingComposerSelection,
  ]);

  const insertDroppedFileReference = useCallback(
    (payload: FileReferencePayload | null) => {
      if (!payload || disabled) return;
      insertFileReferenceTokenAtCaret(payload.relativePath);
      clearCurrentDraggedFileReference();
      window.requestAnimationFrame(() => composerHandleRef.current?.focus());
    },
    [disabled, insertFileReferenceTokenAtCaret]
  );

  useEffect(() => {
    const dropZone = dropZoneRef.current;
    if (!dropZone) return;

    const handleCustomDrop = (event: Event) => {
      const customEvent = event as CustomEvent<FileReferencePayload | null>;
      insertDroppedFileReference(customEvent.detail ?? null);
    };

    dropZone.addEventListener(
      'vibe-file-reference-drop',
      handleCustomDrop as EventListener
    );

    return () => {
      dropZone.removeEventListener(
        'vibe-file-reference-drop',
        handleCustomDrop as EventListener
      );
    };
  }, [insertDroppedFileReference]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const fileReference = getDroppedFileReference(event.dataTransfer);
      if (fileReference) {
        event.preventDefault();
        event.stopPropagation();
        insertDroppedFileReference(fileReference);
        return;
      }

      const files = imageFilesFromFileList(event.dataTransfer.files);
      if (files.length === 0) return;

      event.preventDefault();
      onAttachImages(files);
    },
    [insertDroppedFileReference, onAttachImages]
  );

  return (
    <div
      ref={dropZoneRef}
      className="flex flex-col gap-2"
      data-file-reference-drop-zone
      data-testid="session-composer-file-drop-zone"
    >
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

      <div
        className={cn(
          'min-h-[40px] rounded-lg bg-background/35 px-1.5 py-1 transition-colors focus-within:bg-background/50',
          disabled && 'opacity-60'
        )}
        data-testid="session-composer-input-surface"
      >
        <ChatComposerInput
          value={value}
          onChange={onChange}
          isDisabled={disabled}
          className={cn(
            'min-h-[32px] w-full px-0.5 py-1 font-sans subpixel-antialiased text-[13px] leading-5 tracking-[0.005em]',
            className
          )}
          maxRows={4}
          placeholder=""
          label={t('composer.inputLabel')}
          hasHistory={false}
          pasteAsToken={false}
          triggers={triggers}
          handleRef={composerHandleRef}
          onKeyDown={handleKeyDown}
          onFiles={onAttachImages}
          onDrop={handleDrop}
          onDragOver={(event) => {
            if (hasFileReferenceDrag(event.dataTransfer)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              return;
            }
            if (Array.from(event.dataTransfer.types).includes('Files')) {
              event.preventDefault();
            }
          }}
          data-testid="session-composer-editor"
        />
      </div>
    </div>
  );
}
