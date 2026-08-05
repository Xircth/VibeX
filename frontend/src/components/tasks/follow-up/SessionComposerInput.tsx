import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Image, Loader2, Puzzle, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExecutorProfileId, SendMessageShortcut } from 'shared/types';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { TypeaheadMenu } from '@/components/ui/wysiwyg/plugins/typeahead-menu-components';
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
  agentMentionsToTypeaheadOptions,
  referenceResultsToTypeaheadOptions,
  rootEntriesToFileReferenceOptions,
  slashCommandsToTypeaheadOptions,
  pluginActionsToTypeaheadOptions,
  type ComposerTypeaheadOption,
} from './sessionComposerTypeaheadOptions';
import {
  deleteSessionComposerStructuredToken,
  getSessionComposerStructuredTokenSegments,
  insertFileReferenceToken,
  type SessionComposerStructuredTokenSegment,
} from './sessionComposerStructuredTokens';
import {
  getSessionComposerTokenChipClassName,
  getSessionComposerTokenChipTitle,
} from './SessionComposerStructuredText';
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

type ComposerSelection = {
  start: number;
  end: number;
};

function getRenderedNodeSourceLength(node: ChildNode): number {
  if (node instanceof HTMLElement) {
    const raw = node.dataset.commandRaw;
    if (typeof raw === 'string') {
      return raw.length;
    }

    return Array.from(node.childNodes).reduce(
      (total, child) => total + getRenderedNodeSourceLength(child),
      0
    );
  }

  return node.textContent?.length ?? 0;
}

function getTopLevelEditorChild(
  editor: HTMLDivElement,
  node: Node | null
): ChildNode | null {
  if (!node) return null;
  let current: Node | null = node;

  while (current && current.parentNode !== editor) {
    current = current.parentNode;
  }

  return current instanceof Node ? (current as ChildNode) : null;
}

function sumEditorChildLengths(editor: HTMLDivElement, count: number): number {
  return Array.from(editor.childNodes)
    .slice(0, Math.max(0, count))
    .reduce((total, child) => total + getRenderedNodeSourceLength(child), 0);
}

function getEditorPointOffset(
  editor: HTMLDivElement,
  node: Node,
  offset: number,
  atomicBias: 'start' | 'end' | null = null
): number {
  if (node === editor) {
    return sumEditorChildLengths(editor, offset);
  }

  const topLevelChild = getTopLevelEditorChild(editor, node);
  if (!topLevelChild) {
    return 0;
  }

  const childIndex = Array.from(editor.childNodes).indexOf(topLevelChild);
  const childStart = sumEditorChildLengths(editor, childIndex);

  if (!(topLevelChild instanceof HTMLElement)) {
    return (
      childStart + Math.min(offset, topLevelChild.textContent?.length ?? 0)
    );
  }

  const childEnd = childStart + getRenderedNodeSourceLength(topLevelChild);
  if (typeof topLevelChild.dataset.commandRaw === 'string') {
    if (atomicBias === 'start') return childStart;
    if (atomicBias === 'end') return childEnd;
    return offset <= 0 ? childStart : childEnd;
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return Math.min(childEnd, childStart + offset);
  }

  const textNode = topLevelChild.firstChild;
  const textLength = textNode?.textContent?.length ?? 0;
  if (offset <= 0) {
    return childStart;
  }

  return Math.min(childEnd, childStart + textLength);
}

function getEditorSelection(
  editor: HTMLDivElement,
  atomicBias: 'start' | 'end' | null = null
): ComposerSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const { anchorNode, focusNode, anchorOffset, focusOffset } = selection;
  if (!anchorNode || !focusNode) {
    return null;
  }
  if (!editor.contains(anchorNode) || !editor.contains(focusNode)) {
    return null;
  }

  const collapsedAtomicBias = selection.isCollapsed ? atomicBias : null;

  const anchor = getEditorPointOffset(
    editor,
    anchorNode,
    anchorOffset,
    collapsedAtomicBias
  );
  const focus = getEditorPointOffset(
    editor,
    focusNode,
    focusOffset,
    collapsedAtomicBias
  );

  return anchor <= focus
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

function readEditorValue(editor: HTMLDivElement): string {
  return Array.from(editor.childNodes)
    .map((node) => {
      if (node instanceof HTMLElement) {
        const raw = node.dataset.commandRaw;
        if (typeof raw === 'string') {
          return raw;
        }
      }

      return node.textContent ?? '';
    })
    .join('');
}

function getEditorDomPointForOffset(
  editor: HTMLDivElement,
  offset: number
): { node: Node; offset: number } {
  const childNodes = Array.from(editor.childNodes);
  const totalLength = childNodes.reduce(
    (total, child) => total + getRenderedNodeSourceLength(child),
    0
  );
  let remaining = Math.max(0, Math.min(offset, totalLength));

  for (let index = 0; index < childNodes.length; index += 1) {
    const child = childNodes[index];
    const childLength = getRenderedNodeSourceLength(child);

    if (remaining > childLength) {
      remaining -= childLength;
      continue;
    }

    if (child instanceof HTMLElement) {
      if (typeof child.dataset.commandRaw === 'string') {
        return {
          node: editor,
          offset: remaining === 0 ? index : index + 1,
        };
      }

      const textNode = child.firstChild;
      if (textNode?.nodeType === Node.TEXT_NODE) {
        return {
          node: textNode,
          offset: Math.min(remaining, textNode.textContent?.length ?? 0),
        };
      }
    }

    return {
      node: child,
      offset: Math.min(remaining, child.textContent?.length ?? 0),
    };
  }

  return {
    node: editor,
    offset: childNodes.length,
  };
}

function setEditorSelection(
  editor: HTMLDivElement,
  selection: ComposerSelection
) {
  const normalized = {
    start: Math.max(0, selection.start),
    end: Math.max(0, selection.end),
  };
  const domStart = getEditorDomPointForOffset(editor, normalized.start);
  const domEnd = getEditorDomPointForOffset(editor, normalized.end);
  const range = document.createRange();
  range.setStart(domStart.node, domStart.offset);
  range.setEnd(domEnd.node, domEnd.offset);

  const currentSelection = window.getSelection();
  if (!currentSelection) return;
  currentSelection.removeAllRanges();
  currentSelection.addRange(range);

  if (
    typeof range.getBoundingClientRect !== 'function' ||
    typeof editor.getBoundingClientRect !== 'function'
  ) {
    return;
  }

  const caretRect = range.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  if (
    !Number.isFinite(caretRect.top) ||
    !Number.isFinite(caretRect.bottom) ||
    !Number.isFinite(editorRect.top) ||
    editor.clientHeight <= 0
  ) {
    return;
  }

  const caretTop = caretRect.top - editorRect.top + editor.scrollTop;
  const caretBottom = caretTop + Math.max(caretRect.height, 1);
  const visibleTop = editor.scrollTop;
  const visibleBottom = visibleTop + editor.clientHeight;

  if (caretBottom > visibleBottom) {
    editor.scrollTop = caretBottom - editor.clientHeight;
    return;
  }

  if (caretTop < visibleTop) {
    editor.scrollTop = Math.max(0, caretTop);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderEditorHtml(
  segments: SessionComposerStructuredTokenSegment[]
): string {
  return segments
    .map((segment) => {
      if (segment.kind === 'text') {
        return escapeHtml(segment.text);
      }

      const title = getSessionComposerTokenChipTitle(segment.token);
      const titleAttribute =
        typeof title === 'string' ? ` title="${escapeHtml(title)}"` : '';

      return `<span class="${escapeHtml(
        getSessionComposerTokenChipClassName(segment.token)
      )}" data-testid="session-composer-token-chip" data-token-kind="${escapeHtml(
        segment.token.kind
      )}" data-structured-token-atomic="true" data-command-raw="${escapeHtml(
        segment.token.raw
      )}" data-source-start="${segment.start}" data-source-end="${
        segment.end
      }" contenteditable="false"${titleAttribute}><span class="truncate font-medium">${escapeHtml(
        segment.token.label
      )}</span></span>`;
    })
    .join('');
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
  const editorRef = useRef<HTMLDivElement | null>(null);
  const renderedEditorHtmlRef = useRef<string | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const blurTimerRef = useRef<number | null>(null);
  const selectionRef = useRef<ComposerSelection>({
    start: value.length,
    end: value.length,
  });
  const pendingSelectionRef = useRef<ComposerSelection | null>(null);
  const [typeaheadState, setTypeaheadState] =
    useState<TextareaTypeaheadState | null>(null);
  const [selectedTypeaheadIndex, setSelectedTypeaheadIndex] = useState(0);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const typeaheadTrigger = typeaheadState?.trigger ?? null;
  const typeaheadQuery = typeaheadState?.match.matchingString ?? '';
  const executor = executorProfile?.executor ?? null;
  const agentMentions = useAgentMentions();
  const effectiveRepoIds = useMemo(() => {
    const ids = repoIds?.filter(Boolean) ?? [];
    if (ids.length > 0) return ids;
    return repoId ? [repoId] : [];
  }, [repoId, repoIds]);
  const primaryRepoId = effectiveRepoIds[0] ?? null;
  const structuredSegments = useMemo(() => {
    const segments = getSessionComposerStructuredTokenSegments(value);
    if (agentMentions.candidates.length === 0) return segments;

    return segments.map((segment) => {
      if (segment.kind !== 'token' || segment.token.kind !== 'agent_mention') {
        return segment;
      }
      const candidate = agentMentions.candidates.find(
        (entry) => entry.agent_kind === segment.token.key
      );
      if (!candidate) return segment;

      return {
        ...segment,
        token: {
          ...segment.token,
          label: `&${candidate.display_name}`,
          title: candidate.agent_kind,
        },
      };
    });
  }, [agentMentions.candidates, value]);

  const slashCommandsQuery = useSlashCommands(executorProfile, {
    workspaceId,
    repoId,
  });
  const pluginApi = useMemo(() => createPluginApi(transport), [transport]);
  const {
    data: pluginCatalog,
    isLoading: isPluginCatalogLoading,
    isFetching: isPluginCatalogFetching,
  } = useQuery({
    queryKey: ['session-composer-plugin-actions', transport.environment],
    queryFn: () => pluginApi.catalog(),
    enabled: typeaheadTrigger === '!',
    staleTime: 5_000,
  });
  const {
    data: pluginAgentSkills,
    isLoading: isPluginAgentSkillsLoading,
    isFetching: isPluginAgentSkillsFetching,
  } = useQuery({
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
    enabled: typeaheadTrigger === '!' && !!executor,
    staleTime: 0,
  });
  const hostedPluginSkillIds = useMemo(
    () => new Set(pluginAgentSkills?.skills.map((skill) => skill.id) ?? []),
    [pluginAgentSkills]
  );
  const { data: localSkills = [] } = useQuery({
    queryKey: ['local-agent-skills', 'codex'],
    queryFn: () => skillsApi.listLocal('codex'),
    enabled: typeaheadTrigger === '$' || typeaheadTrigger === '/',
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

    if (typeaheadState.trigger === '&') {
      return agentMentionsToTypeaheadOptions(
        agentMentions.candidates,
        typeaheadQuery
      );
    }

    if (typeaheadState.trigger === '!') {
      return pluginActionsToTypeaheadOptions(
        pluginCatalog,
        typeaheadQuery,
        hostedPluginSkillIds
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
    agentMentions.candidates,
    executor,
    hostedPluginSkillIds,
    initialRootEntries,
    pluginCatalog,
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
      isSearchingReferences) ||
    (typeaheadTrigger === '&' && agentMentions.loading);
  const pluginTypeaheadLoading =
    typeaheadTrigger === '!' &&
    (isPluginCatalogLoading ||
      isPluginCatalogFetching ||
      isPluginAgentSkillsLoading ||
      isPluginAgentSkillsFetching);
  const isAnyTypeaheadLoading = isTypeaheadLoading || pluginTypeaheadLoading;
  const shouldShowTypeahead =
    !!typeaheadState &&
    (typeaheadOptions.length > 0 ||
      isTypeaheadLoading ||
      typeaheadTrigger === '$' ||
      typeaheadTrigger === '@' ||
      typeaheadTrigger === '#' ||
      typeaheadTrigger === '&' ||
      typeaheadTrigger === '!' ||
      (typeaheadTrigger === '/' && !!executor));
  const typeaheadEmptyText = useMemo(() => {
    if (isAnyTypeaheadLoading) {
      if (typeaheadTrigger === '@') return 'Searching files...';
      if (typeaheadTrigger === '#') return 'Searching tags...';
      if (typeaheadTrigger === '&') return t('agentMention.loading');
      if (typeaheadTrigger === '!') return t('pluginActions.loading');
      return 'Loading commands...';
    }

    if (typeaheadTrigger === '@') return 'No matching files found.';
    if (typeaheadTrigger === '#') return 'No matching tags found.';
    if (typeaheadTrigger === '&') return t('agentMention.noMatches');
    if (typeaheadTrigger === '!') return t('pluginActions.noMatches');
    return 'No matching commands found.';
  }, [isAnyTypeaheadLoading, t, typeaheadTrigger]);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current !== null) {
        window.clearTimeout(blurTimerRef.current);
      }
    };
  }, []);

  const syncTypeaheadFromSelection = useCallback(
    (
      nextValue: string = value,
      nextSegments: SessionComposerStructuredTokenSegment[] = structuredSegments,
      nextSelection: ComposerSelection = selectionRef.current
    ) => {
      if (disabled || nextSelection.start !== nextSelection.end) {
        setTypeaheadState(null);
        return;
      }

      setTypeaheadState(
        getTextareaTypeaheadState(nextValue, nextSelection.end, nextSegments)
      );
    },
    [disabled, structuredSegments, value]
  );

  // P2-4: consume a code selection requested from a file viewer, inserting a
  // `@path:start-end` reference at the caret (or end of input).
  const pendingComposerSelection = useComposerSelectionStore((s) => s.pending);
  const consumeComposerSelection = useComposerSelectionStore((s) => s.consume);
  useEffect(() => {
    if (!pendingComposerSelection || disabled) return;
    const consumed = consumeComposerSelection();
    if (!consumed) return;
    const relativePath = formatFileRangeRef(
      consumed.filePath,
      consumed.startLine,
      consumed.endLine
    );
    const editor = editorRef.current;
    const hasActiveEditor = !!editor && document.activeElement === editor;
    const selection = hasActiveEditor
      ? (getEditorSelection(editor) ?? selectionRef.current)
      : { start: value.length, end: value.length };
    const next = insertFileReferenceToken({
      value,
      selectionStart: selection.start,
      selectionEnd: selection.end,
      relativePath,
    });
    pendingSelectionRef.current = {
      start: next.caretOffset,
      end: next.caretOffset,
    };
    onChange(next.value);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  }, [
    pendingComposerSelection,
    consumeComposerSelection,
    disabled,
    value,
    onChange,
  ]);

  const insertDroppedFileReference = useCallback(
    (payload: FileReferencePayload | null) => {
      if (!payload || disabled) return;

      const editor = editorRef.current;
      const hasActiveEditor = !!editor && document.activeElement === editor;
      const selection = hasActiveEditor
        ? (getEditorSelection(editor) ?? selectionRef.current)
        : { start: value.length, end: value.length };
      const next = insertFileReferenceToken({
        value,
        selectionStart: selection.start,
        selectionEnd: selection.end,
        relativePath: payload.relativePath,
      });
      pendingSelectionRef.current = {
        start: next.caretOffset,
        end: next.caretOffset,
      };
      onChange(next.value);
      clearCurrentDraggedFileReference();
      window.requestAnimationFrame(() => {
        editorRef.current?.focus();
      });
    },
    [disabled, onChange, value]
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

  const closeTypeahead = useCallback(() => {
    setTypeaheadState(null);
    setSelectedTypeaheadIndex(0);
  }, []);

  const renderedEditorHtml = useMemo(
    () => renderEditorHtml(structuredSegments),
    [structuredSegments]
  );

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const didPresentationChange =
      renderedEditorHtmlRef.current !== renderedEditorHtml;
    const didSyncDom =
      readEditorValue(editor) !== value || didPresentationChange;
    if (didSyncDom) {
      editor.innerHTML = renderedEditorHtml;
      renderedEditorHtmlRef.current = renderedEditorHtml;
    }
    if (!isInputFocused) return;
    if (!didSyncDom && pendingSelectionRef.current === null) return;

    const nextSelection = pendingSelectionRef.current ?? selectionRef.current;
    const normalized = {
      start: Math.max(0, Math.min(nextSelection.start, value.length)),
      end: Math.max(0, Math.min(nextSelection.end, value.length)),
    };

    setEditorSelection(editor, normalized);
    selectionRef.current = normalized;
    pendingSelectionRef.current = null;
    syncTypeaheadFromSelection(value, structuredSegments, normalized);
  }, [
    isInputFocused,
    renderedEditorHtml,
    structuredSegments,
    syncTypeaheadFromSelection,
    value,
  ]);

  const syncSelectionState = useCallback(
    (nextValue: string = value) => {
      const editor = editorRef.current;
      if (!editor) return;

      const nextSelection = getEditorSelection(editor) ?? {
        start: nextValue.length,
        end: nextValue.length,
      };
      selectionRef.current = nextSelection;
      syncTypeaheadFromSelection(
        nextValue,
        getSessionComposerStructuredTokenSegments(nextValue),
        nextSelection
      );
    },
    [syncTypeaheadFromSelection, value]
  );

  const commitTypeaheadOption = useCallback(
    (option: ComposerTypeaheadOption) => {
      if (!typeaheadState) return;

      const next = replaceTextareaTypeaheadRange(
        value,
        typeaheadState.match,
        option.insertText
      );
      pendingSelectionRef.current = {
        start: next.caretOffset,
        end: next.caretOffset,
      };
      onChange(next.value);
      closeTypeahead();
    },
    [closeTypeahead, onChange, typeaheadState, value]
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = extractImageFilesFromClipboardData(event.clipboardData);
      if (files.length > 0) {
        event.preventDefault();
        onAttachImages(files);
        return;
      }

      if (clipboardDataHasTextPayload(event.clipboardData)) {
        const pastedText = event.clipboardData.getData('text/plain');
        if (pastedText) {
          event.preventDefault();
          const editor = editorRef.current;
          const selection = editor
            ? (getEditorSelection(editor) ?? selectionRef.current)
            : selectionRef.current;
          const nextValue =
            value.slice(0, selection.start) +
            pastedText +
            value.slice(selection.end);
          const caretOffset = selection.start + pastedText.length;
          pendingSelectionRef.current = {
            start: caretOffset,
            end: caretOffset,
          };
          onChange(nextValue);
          closeTypeahead();
        }
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
    [closeTypeahead, onAttachImages, onChange, value]
  );

  const handleCopy = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const selection = getEditorSelection(event.currentTarget);
      if (!selection || selection.start === selection.end) return;

      const containsStructuredToken = structuredSegments.some(
        (segment) =>
          segment.kind === 'token' &&
          segment.end > selection.start &&
          segment.start < selection.end
      );
      if (!containsStructuredToken) return;

      event.preventDefault();
      event.clipboardData.setData(
        'text/plain',
        value.slice(selection.start, selection.end)
      );
    },
    [structuredSegments, value]
  );

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
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      onAttachImages(files);
    },
    [insertDroppedFileReference, onAttachImages]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      syncSelectionState();

      if (event.key === 'Backspace' || event.key === 'Delete') {
        const selection =
          getEditorSelection(
            event.currentTarget,
            event.key === 'Backspace' ? 'end' : 'start'
          ) ?? selectionRef.current;
        const deletion = deleteSessionComposerStructuredToken({
          value,
          selectionStart: selection.start,
          selectionEnd: selection.end,
          direction: event.key === 'Backspace' ? 'backward' : 'forward',
        });

        if (deletion) {
          event.preventDefault();
          pendingSelectionRef.current = {
            start: deletion.caretOffset,
            end: deletion.caretOffset,
          };
          onChange(deletion.value);
          closeTypeahead();
          return;
        }
      }

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

          if (isAnyTypeaheadLoading) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
      }

      // Ignore the Enter that commits an IME composition (e.g. selecting a
      // Chinese/Japanese candidate). Without this guard that commit-Enter fires
      // a submit, and the user's follow-up Enter fires a second one — sending the
      // same message twice (two turns → two responses). `isComposing` is true on
      // the keydown that ends composition; keyCode 229 covers older IME stacks.
      if (
        disabled ||
        event.key !== 'Enter' ||
        event.nativeEvent.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }

      const shouldSubmit =
        sendShortcut === 'Enter'
          ? !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
          : (event.metaKey || event.ctrlKey) && !event.shiftKey;

      if (!shouldSubmit) {
        const selection =
          getEditorSelection(event.currentTarget) ?? selectionRef.current;
        const currentValue = readEditorValue(event.currentTarget);
        const nextSelection = {
          start: selection.start + 1,
          end: selection.start + 1,
        };
        event.preventDefault();
        event.stopPropagation();
        pendingSelectionRef.current = nextSelection;
        selectionRef.current = nextSelection;
        onChange(
          currentValue.slice(0, selection.start) +
            '\n' +
            currentValue.slice(selection.end)
        );
        closeTypeahead();
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
      isAnyTypeaheadLoading,
      onChange,
      onSubmit,
      selectedTypeaheadIndex,
      sendShortcut,
      syncSelectionState,
      typeaheadOptions,
      typeaheadState,
      value,
    ]
  );

  const handleInput = useCallback(
    (event: FormEvent<HTMLDivElement>) => {
      if (disabled) return;

      const editor = event.currentTarget;
      const nextValue = readEditorValue(editor);
      const nextSelection = getEditorSelection(editor) ?? {
        start: nextValue.length,
        end: nextValue.length,
      };

      selectionRef.current = nextSelection;
      pendingSelectionRef.current = null;
      onChange(nextValue);
      syncTypeaheadFromSelection(
        nextValue,
        getSessionComposerStructuredTokenSegments(nextValue),
        nextSelection
      );
    },
    [disabled, onChange, syncTypeaheadFromSelection]
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
        <div
          ref={editorRef}
          role="textbox"
          aria-label={t('composer.inputLabel')}
          aria-multiline="true"
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          data-testid="session-composer-editor"
          className={cn(
            'max-h-[100px] min-h-[32px] w-full overflow-y-auto whitespace-pre-wrap break-words px-0.5 py-1 font-sans subpixel-antialiased text-[13px] leading-5 tracking-[0.005em] text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground disabled:cursor-not-allowed',
            disabled && 'cursor-not-allowed opacity-60',
            className
          )}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onKeyUp={() => syncSelectionState()}
          onMouseUp={() => syncSelectionState()}
          onClick={() => syncSelectionState()}
          onFocus={() => {
            setIsInputFocused(true);
            if (blurTimerRef.current !== null) {
              window.clearTimeout(blurTimerRef.current);
              blurTimerRef.current = null;
            }
            const editor = editorRef.current;
            const pendingSelection = pendingSelectionRef.current;
            if (editor && pendingSelection) {
              setEditorSelection(editor, pendingSelection);
              selectionRef.current = pendingSelection;
              pendingSelectionRef.current = null;
              syncTypeaheadFromSelection(
                value,
                structuredSegments,
                pendingSelection
              );
              return;
            }

            syncSelectionState();
          }}
          onBlur={() => {
            setIsInputFocused(false);
            blurTimerRef.current = window.setTimeout(() => {
              closeTypeahead();
            }, 120);
          }}
          onPaste={handlePaste}
          onCopy={handleCopy}
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
        />
      </div>
      {shouldShowTypeahead && editorRef.current
        ? createPortal(
            <TypeaheadMenu anchorEl={editorRef.current}>
              {typeaheadTrigger === '!' ? (
                <TypeaheadMenu.Header>
                  <Puzzle className="h-3.5 w-3.5 text-primary" />
                  <span>{t('pluginActions.invokeMenuTitle')}</span>
                </TypeaheadMenu.Header>
              ) : null}
              {typeaheadTrigger === '&' &&
              agentMentions.capability === 'unsupported' ? (
                <TypeaheadMenu.Header>
                  <span
                    role="status"
                    aria-label={t('agentMention.companionUnsupported')}
                    className="flex items-start gap-1.5 text-[hsl(var(--warning))]"
                  >
                    <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{t('agentMention.companionUnsupported')}</span>
                  </span>
                </TypeaheadMenu.Header>
              ) : null}
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
