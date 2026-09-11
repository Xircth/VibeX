import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import {
  FileText,
  FolderOpen,
  Image,
  Loader2,
  MousePointer2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExecutorProfileId } from 'shared/types';
import {
  ChatComposerDrawer,
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerToken,
  type ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import type {
  SearchableItem,
  SearchSource,
} from '@astryxdesign/core/Typeahead';
import {
  SESSION_COMPOSER_TOKEN_VARIANTS,
  SessionComposerTokenIcon,
} from './SessionComposerStructuredText';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { toast } from '@/components/ui/toast';
import { materializeMentionedHostFiles } from '@/lib/materializeHostReferences';
import { mentionedHostFileNames } from '@/lib/savedHostSshConfig';
import {
  fileTreeApi,
  type AgentLocalSkill,
  type AgentSkillsListResult,
} from '@/lib/api';
import {
  configuredBackendTransport,
  type BackendTransport,
} from '@/lib/backendTransport';
import { createPluginApi, createPluginControlApi } from '@/lib/api/plugins';
import { DOLLAR_COMMANDS, mergeDollarCommands } from '@/lib/dollarCommands';
import {
  agentAvailableCommandsToSlashCommands,
  localSkillsToDollarCommands,
  mergeComposerSlashCommands,
  pluginComposerSlashContributions,
  pluginInvocationsToSlashCommands,
} from '@/lib/conversation-rendering/commandSources';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { cn } from '@/lib/utils';
import {
  COMPOSER_INSERT_EVENT,
  type ComposerInsertDetail,
} from '@/lib/composerInsert';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { useComposerSelectionStore } from '@/stores/useComposerSelectionStore';
import {
  extractImageFilesFromClipboardData,
  prepareImageFileForUpload,
  readImageFilesFromNavigatorClipboard,
} from '@/utils/clipboard';
import { formatFileRangeRef } from '@/utils/codeSelection';
import {
  fileExtension,
  isAttachableFile,
  isImageExtension,
  isVideoExtension,
} from '@/utils/mediaAttachments';
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
  slashCommandsToTypeaheadOptions,
  type ComposerTypeaheadOption,
} from './sessionComposerTypeaheadOptions';
import { QuoteTokenPreview } from './QuoteTokenPreview';
import {
  formatSessionComposerCommand,
  getSessionComposerStructuredTokenSegments,
  type SessionComposerStructuredToken,
  type SessionComposerStructuredTokenKind,
} from './sessionComposerStructuredTokens';
import { useAgentMentions } from './AgentMention';
import {
  composerEnterAction,
  isComposerImeCommitEnter,
} from './sessionComposerSubmitHotkey';
import {
  isComposerCaretAtDocumentStart,
  isComposerHistoryNavigationKey,
  mergeComposerMessageHistory,
  shouldNavigateComposerHistory,
  stepComposerHistory,
} from './sessionComposerHistory';
import { ComposerAtReferencePanel } from './ComposerAtReferenceMenu';
import { useComposerAtReferencePanel } from './useComposerAtReferencePanel';
import {
  fileFromHostPath,
  hostPathFileName,
  isPointInElement,
  relativePathInsideRoot,
} from './composerHostFileDrop';

export type SessionComposerImage = {
  id: string;
  name: string;
  path: string;
  previewUrl?: string;
};

export type SessionComposerInputContext = {
  sessionId?: string;
  workspaceId?: string;
  workspacePath?: string;
  repoId?: string;
  repoIds?: string[];
  projectId?: string;
  executorProfile?: ExecutorProfileId | null;
  availableCommands?: AgentAvailableCommand[] | null;
  commandsLoading?: boolean;
  transport?: BackendTransport;
};

type SessionComposerInputProps = {
  value: string;
  disabled?: boolean;
  className?: string;
  context?: SessionComposerInputContext;
  messageHistory?: readonly string[];
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onAttachImages: (files: File[]) => void;
};

function attachableFilesFromFileList(
  files: FileList | null | undefined
): File[] {
  return Array.from(files ?? [])
    .filter(isAttachableFile)
    .map(prepareImageFileForUpload);
}

function attachmentPreviewKind(extension: string): 'image' | 'video' | 'file' {
  if (isVideoExtension(extension)) return 'video';
  if (isImageExtension(extension)) return 'image';
  return 'file';
}

/**
 * Paste handler for screenshots and other attached files. Astryx reads
 * `clipboardData.files` before calling this prop, so file payloads usually
 * arrive here either as clipboard *items* (recovered synchronously) or
 * through the async `navigator.clipboard.read()` fallback (e.g. an image
 * copied off a webpage). Returns `true` when a file was handed to
 * `onAttachImages`, telling Astryx to skip its default text insert;
 * plain-text and empty pastes return `false` so normal composer behavior is
 * untouched.
 */
export function handleComposerImagePaste(
  event: { clipboardData: DataTransfer | null },
  onAttachImages: (files: File[]) => void,
  disabled = false
): boolean {
  if (disabled) {
    return false;
  }
  const files = extractImageFilesFromClipboardData(event.clipboardData);
  if (files.length > 0) {
    onAttachImages(files.map(prepareImageFileForUpload));
    return true;
  }
  void readImageFilesFromNavigatorClipboard()
    .then((fallbackFiles) => {
      if (fallbackFiles.length > 0) {
        onAttachImages(fallbackFiles.map(prepareImageFileForUpload));
      }
    })
    .catch(() => undefined);
  return false;
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

  const previewKind = attachmentPreviewKind(
    fileExtension(image.name) || metadata?.format || ''
  );

  const handlePreview = useCallback(() => {
    if (previewKind === 'file' || !imageUrl || imageLoadFailed) return;

    ImagePreviewDialog.show({
      imageUrl,
      altText: label,
      fileName: label,
      format: metadata?.format ?? fileExtension(image.name) ?? undefined,
      sizeBytes: metadata?.size_bytes,
    });
  }, [imageLoadFailed, imageUrl, image.name, label, metadata, previewKind]);

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
        disabled={previewKind === 'file' || !imageUrl || imageLoadFailed}
        aria-label={previewKind === 'file' ? label : `Preview ${label}`}
      >
        {previewKind === 'file' ? (
          <span
            className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-muted-foreground"
            data-testid="session-composer-file-attachment"
          >
            <FileText className="h-5 w-5" />
            <span className="w-full truncate text-center text-[10px] leading-tight text-foreground">
              {fileExtension(label).toUpperCase() || label}
            </span>
          </span>
        ) : imageUrl && !imageLoadFailed ? (
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

export function SessionComposerAttachmentDrawer({
  images,
  disabled = false,
  taskAttemptId,
  taskId,
  onRemoveImage,
}: {
  images: SessionComposerImage[];
  disabled?: boolean;
  taskAttemptId?: string;
  taskId?: string;
  onRemoveImage: (imageId: string) => void;
}) {
  const { t } = useTranslation('tasks');
  if (images.length === 0) return null;

  return (
    <ChatComposerDrawer
      count={images.length}
      label={t('composer.attachments')}
      className="session-composer-attachment-drawer"
      data-testid="session-composer-attachment-drawer"
    >
      <div className="flex flex-wrap gap-2">
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
    </ChatComposerDrawer>
  );
}

/** Wrap a composer option as a SearchableItem, keeping its insert text. */
function toSearchableItem(option: ComposerTypeaheadOption): SearchableItem {
  const kind = option.key.startsWith('slash-')
    ? 'slash'
    : option.key.startsWith('dollar-')
      ? 'dollar'
      : option.key.startsWith('agent-')
        ? 'agent_mention'
        : option.key.startsWith('plugin-')
          ? 'plugin_action'
          : option.key.startsWith('tag-')
            ? 'tag'
            : option.key.startsWith('conversation-')
              ? 'conversation'
              : option.key.startsWith('commit-')
                ? 'commit'
                : 'file';
  return {
    id: option.key,
    label: option.label,
    auxiliaryData: {
      insertText: option.insertText,
      description: option.description,
      kind,
      agentKind:
        kind === 'agent_mention'
          ? option.key.slice('agent-'.length)
          : undefined,
      commandSourceKind: option.sourceKind,
    },
  };
}

type ComposerSearchItemData = {
  insertText?: string;
  description?: string;
  kind?: SessionComposerStructuredTokenKind;
  agentKind?: string;
  commandSourceKind?: 'native' | 'skill' | 'plugin';
};

function getTokenFromInsertText(
  insertText: string
): SessionComposerStructuredToken | null {
  const segment = getSessionComposerStructuredTokenSegments(insertText).find(
    (candidate) => candidate.kind === 'token'
  );
  return segment?.kind === 'token' ? segment.token : null;
}

type PreviewElementTokenDetails = {
  dom?: string;
  selector?: string;
  source?: string;
  html?: string;
};

function parsePreviewElementTokenDetails(
  token: SessionComposerStructuredToken
): PreviewElementTokenDetails {
  const context = token.value;
  const dom = context.match(/^- DOM:\s*(.+)$/m)?.[1]?.trim();
  const selector = context
    .match(/^- Selector:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^`|`$/g, '');
  const source = context
    .match(/^- Selected start:.*?\((?:`([^`]+)`|([^\n)]+))\)$/m)
    ?.slice(1)
    .find(Boolean)
    ?.trim();
  const html = context
    .match(/^- Element source:\s*\n```html\s*\n([\s\S]*?)\n```/m)?.[1]
    ?.trim();

  return { dom, selector, source, html };
}

function getHoverableTokenFromEventTarget(
  target: EventTarget | null
): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(
        '[data-astryx-token][data-token-kind="element"],' +
          ' [data-astryx-token][data-token-kind="quote"]'
      )
    : null;
}

function getStructuredHoverToken(
  element: HTMLElement
): SessionComposerStructuredToken | null {
  const raw = element.dataset.astryxTokenValue;
  if (!raw) return null;
  const token = getTokenFromInsertText(raw);
  return token?.kind === 'element' || token?.kind === 'quote' ? token : null;
}

function PreviewElementTokenTooltip({
  anchor,
  id,
  token,
}: {
  anchor: HTMLElement;
  id: string;
  token: SessionComposerStructuredToken;
}) {
  const { t } = useTranslation('tasks');
  const portalContainer = usePortalContainer();
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<CSSProperties>({
    left: 0,
    top: 0,
    visibility: 'hidden',
  });
  const details = useMemo(
    () => parsePreviewElementTokenDetails(token),
    [token]
  );

  useLayoutEffect(() => {
    const updatePosition = () => {
      const tooltip = tooltipRef.current;
      if (!tooltip || !anchor.isConnected) return;

      const anchorRect = anchor.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const margin = 8;
      const gap = 7;
      const width = tooltipRect.width || 320;
      const height = tooltipRect.height || 160;
      const centeredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
      const left = Math.min(
        Math.max(margin, centeredLeft),
        Math.max(margin, viewportWidth - width - margin)
      );
      const preferredTop = anchorRect.top - height - gap;
      const top =
        preferredTop >= margin
          ? preferredTop
          : Math.min(
              anchorRect.bottom + gap,
              Math.max(margin, viewportHeight - height - margin)
            );

      setPosition({ left, top, visibility: 'visible' });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchor]);

  const content = (
    <div
      ref={tooltipRef}
      id={id}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-[min(22rem,calc(100vw-1rem))] rounded-lg bg-[var(--surface-glass-solid)] p-3 text-xs text-foreground shadow-[var(--shadow-card)] ring-1 ring-[var(--border-strong)]"
      style={position}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.12)] text-primary">
          <MousePointer2 className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground">
            {token.label}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {t('composer.elementToken.type')}
          </span>
        </span>
      </div>

      <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1.5">
        {details.dom ? (
          <>
            <dt className="text-muted-foreground">DOM</dt>
            <dd className="min-w-0 truncate font-mono text-[11px] text-foreground">
              {details.dom}
            </dd>
          </>
        ) : null}
        {details.source ? (
          <>
            <dt className="text-muted-foreground">
              {t('composer.elementToken.source')}
            </dt>
            <dd className="min-w-0 truncate font-mono text-[11px] text-foreground">
              {details.source}
            </dd>
          </>
        ) : null}
        {details.selector ? (
          <>
            <dt className="text-muted-foreground">
              {t('composer.elementToken.selector')}
            </dt>
            <dd className="min-w-0 truncate font-mono text-[11px] text-foreground">
              {details.selector}
            </dd>
          </>
        ) : null}
      </dl>

      {details.html ? (
        <div className="mt-2.5 border-t border-border/60 pt-2">
          <div className="mb-1 text-[11px] text-muted-foreground">
            {t('composer.elementToken.html')}
          </div>
          <pre className="max-h-20 overflow-hidden whitespace-pre-wrap break-all rounded-md bg-[var(--surface-control)] px-2 py-1.5 font-mono text-[11px] leading-4 text-foreground">
            {details.html.slice(0, 600)}
            {details.html.length > 600 ? '…' : ''}
          </pre>
        </div>
      ) : null}
    </div>
  );

  return createPortal(content, portalContainer ?? document.body);
}

function ComposerTriggerMenuItem({ item }: { item: SearchableItem }) {
  const { t } = useTranslation('tasks');
  const data = item.auxiliaryData as ComposerSearchItemData | undefined;
  const kind = data?.kind ?? 'file';
  const iconToken = {
    kind,
    value: data?.agentKind ?? '',
  } satisfies Pick<SessionComposerStructuredToken, 'kind' | 'value'>;

  return (
    <div
      className="flex min-w-0 items-center gap-2.5"
      data-composer-trigger-kind={kind}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          kind === 'slash' && 'bg-blue-500/10 text-blue-600 dark:text-blue-300',
          kind === 'dollar' &&
            'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
          (kind === 'file' ||
            kind === 'tag' ||
            kind === 'conversation' ||
            kind === 'commit' ||
            kind === 'element' ||
            kind === 'quote') &&
            'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
          kind === 'plugin_action' &&
            'bg-pink-500/10 text-pink-700 dark:text-pink-300',
          kind === 'agent_mention' &&
            'bg-violet-500/10 text-violet-700 dark:text-violet-300'
        )}
      >
        <SessionComposerTokenIcon token={iconToken} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="composer-trigger-label block truncate font-medium text-foreground"
          data-composer-trigger-label
        >
          {item.label}
        </span>
        {data?.description ? (
          <span
            className="composer-trigger-description block truncate text-muted-foreground"
            data-composer-trigger-description
          >
            {data.description}
          </span>
        ) : null}
        {data?.commandSourceKind ? (
          <span className="mt-1 inline-flex rounded border border-border/70 bg-muted/45 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
            {t(`composer.commandSource.${data.commandSourceKind}`)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** File-reference token text for a relative path (matches the legacy `@` syntax). */
function fileReferenceTokenText(relativePath: string): string {
  return formatSessionComposerCommand({
    type: '@',
    key: getFileName(relativePath),
    value: relativePath,
  });
}

function decorateStructuredTokenElement(
  element: HTMLElement,
  token: SessionComposerStructuredToken
) {
  element.dataset.tokenKind = token.kind;
  if (token.kind === 'element') {
    element.dataset.previewElementToken = '';
    delete element.dataset.quoteToken;
    element.tabIndex = 0;
  } else if (token.kind === 'quote') {
    element.dataset.quoteToken = '';
    delete element.dataset.previewElementToken;
    element.tabIndex = 0;
  } else {
    delete element.dataset.previewElementToken;
    delete element.dataset.quoteToken;
    element.removeAttribute('tabindex');
  }
}

function getSessionComposerEditable(
  composerRoot: HTMLDivElement | null
): HTMLElement | null {
  return (
    composerRoot?.querySelector<HTMLElement>(
      '[contenteditable="true"], [contenteditable="false"][role="combobox"]'
    ) ?? null
  );
}

function prepareEmptyComposerForTokenInsert(editor: HTMLElement | null) {
  if (!editor) return;
  if (editor.querySelector('[data-astryx-token]')) return;
  const text = (editor.textContent ?? '').replace(/[\u200B\uFEFF\u00A0]/g, '');
  if (text.trim() !== '') return;
  // Empty contenteditables keep a caret <br>. insertToken then places the
  // chip after it, so serialize() starts with a newline and the token drops
  // to the second line.
  editor.replaceChildren();
}

function restoreStructuredTokens(
  composerRoot: HTMLDivElement,
  value: string,
  bareAgentMentions?: Array<{ agent_kind: string; display_name: string }>
): void {
  const editor = getSessionComposerEditable(composerRoot);
  if (!editor) return;

  const segments = getSessionComposerStructuredTokenSegments(value, {
    bareAgentMentions,
  });
  const tokenSegments = segments.filter((segment) => segment.kind === 'token');
  if (tokenSegments.length === 0) return;

  const existingTokens = Array.from(
    editor.querySelectorAll<HTMLElement>('[data-astryx-token]')
  );
  if (
    existingTokens.length === tokenSegments.length &&
    existingTokens.every(
      (element, index) =>
        element.dataset.astryxTokenValue === tokenSegments[index].token.raw
    )
  ) {
    existingTokens.forEach((element, index) => {
      decorateStructuredTokenElement(element, tokenSegments[index].token);
    });
    return;
  }

  const wasFocused = document.activeElement === editor;
  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    if (segment.kind === 'text') {
      fragment.append(document.createTextNode(segment.text));
      continue;
    }

    const token = document.createElement('span');
    token.setAttribute('data-astryx-token', '');
    token.setAttribute('data-astryx-token-value', segment.token.raw);
    token.setAttribute('data-astryx-restored-token', '');
    token.contentEditable = 'false';
    token.textContent = segment.token.label;
    decorateStructuredTokenElement(token, segment.token);
    fragment.append(token);
  }
  editor.replaceChildren(fragment);

  if (wasFocused) {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
}

function syncTriggerMenuWidth(composerRoot: HTMLDivElement): void {
  const width = composerRoot.getBoundingClientRect().width;
  if (width <= 0) return;

  const menu = composerRoot.querySelector('.astryx-trigger-menu');
  const popover = menu?.closest<HTMLElement>('[popover]');
  if (popover) {
    popover.style.width = `${Math.round(width)}px`;
  }
}

export function SessionComposerInput({
  value,
  disabled = false,
  className,
  context,
  messageHistory,
  onChange,
  onSubmit,
  onAttachImages,
}: SessionComposerInputProps) {
  const { t } = useTranslation('tasks');
  const sendShortcut =
    useOptionalUserSystem()?.config?.send_message_shortcut ?? 'Enter';
  const {
    sessionId,
    workspaceId,
    workspacePath,
    repoId,
    repoIds,
    projectId,
    executorProfile,
    availableCommands = null,
    commandsLoading = false,
    transport = configuredBackendTransport,
  } = context ?? {};
  const composerHandleRef = useRef<ChatComposerInputHandle | null>(null);
  const composerRootRef = useRef<HTMLDivElement | null>(null);
  const lastCompositionEndAtRef = useRef(Number.NEGATIVE_INFINITY);
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef('');
  const localSubmitsRef = useRef<string[]>([]);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const dropActiveRef = useRef(false);
  const [dropActive, setDropActive] = useState(false);
  const setComposerDropActive = useCallback((active: boolean) => {
    dropActiveRef.current = active;
    setDropActive(active);
  }, []);
  const elementTokenTooltipId = useId();
  const quoteTokenTooltipId = useId();
  const hoverHideTimerRef = useRef<number | null>(null);
  const [activeHoverToken, setActiveHoverToken] = useState<{
    anchor: HTMLElement;
    token: SessionComposerStructuredToken;
  } | null>(null);
  const agentMentions = useAgentMentions();
  const executor = executorProfile?.executor ?? null;

  const cancelHoverHide = useCallback(() => {
    if (hoverHideTimerRef.current != null) {
      window.clearTimeout(hoverHideTimerRef.current);
      hoverHideTimerRef.current = null;
    }
  }, []);

  const showTokenHover = useCallback(
    (target: EventTarget | null) => {
      const anchor = getHoverableTokenFromEventTarget(target);
      if (!anchor) return;
      const token = getStructuredHoverToken(anchor);
      if (!token) return;
      cancelHoverHide();
      setActiveHoverToken((current) =>
        current?.anchor === anchor && current.token.raw === token.raw
          ? current
          : { anchor, token }
      );
    },
    [cancelHoverHide]
  );

  const hideTokenHover = useCallback(
    (anchor: HTMLElement, delayMs = 0) => {
      const hide = () => {
        setActiveHoverToken((current) =>
          current?.anchor === anchor ? null : current
        );
        hoverHideTimerRef.current = null;
      };
      cancelHoverHide();
      if (delayMs <= 0) {
        hide();
        return;
      }
      hoverHideTimerRef.current = window.setTimeout(hide, delayMs);
    },
    [cancelHoverHide]
  );

  const handleTokenPointerOver = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      showTokenHover(event.target);
    },
    [showTokenHover]
  );

  const handleTokenPointerOut = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const anchor = getHoverableTokenFromEventTarget(event.target);
      if (!anchor) return;
      if (
        event.relatedTarget instanceof Node &&
        anchor.contains(event.relatedTarget)
      ) {
        return;
      }
      hideTokenHover(anchor, 120);
    },
    [hideTokenHover]
  );

  const handleTokenFocus = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      showTokenHover(event.target);
    },
    [showTokenHover]
  );

  const handleTokenBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const anchor = getHoverableTokenFromEventTarget(event.target);
      if (anchor) hideTokenHover(anchor, 120);
    },
    [hideTokenHover]
  );

  const composerActions = usePluginHostContributions('composer_action');
  const atReference = useComposerAtReferencePanel({
    composerRootRef,
    composerHandleRef,
    context: {
      sessionId,
      workspaceId,
      repoId,
      repoIds,
      projectId,
      transport,
      actions: composerActions.map((item) => {
        const metadata = contributionMetadata(item);
        const prompt =
          typeof metadata.prompt === 'string' ? metadata.prompt : item.label;
        return {
          id: `${item.pluginId}/${item.id}`,
          title: item.label,
          detail:
            typeof metadata.title === 'string' ? metadata.title : undefined,
          insertText: prompt,
        };
      }),
    },
    disabled,
    onChange,
  });

  useEffect(() => {
    if (composerRootRef.current) {
      restoreStructuredTokens(
        composerRootRef.current,
        value,
        agentMentions.capability === 'supported'
          ? agentMentions.candidates
          : undefined
      );
    }
  }, [agentMentions.candidates, agentMentions.capability, value]);

  useEffect(() => {
    const anchor = activeHoverToken?.anchor;
    if (!anchor) return undefined;
    const tooltipId =
      activeHoverToken.token.kind === 'quote'
        ? quoteTokenTooltipId
        : elementTokenTooltipId;

    const previousDescription = anchor.getAttribute('aria-describedby');
    const descriptionIds = new Set(
      previousDescription?.split(/\s+/).filter(Boolean) ?? []
    );
    descriptionIds.add(tooltipId);
    anchor.setAttribute(
      'aria-describedby',
      Array.from(descriptionIds).join(' ')
    );

    return () => {
      const remainingIds = new Set(
        anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ??
          []
      );
      remainingIds.delete(tooltipId);
      if (remainingIds.size > 0) {
        anchor.setAttribute(
          'aria-describedby',
          Array.from(remainingIds).join(' ')
        );
      } else {
        anchor.removeAttribute('aria-describedby');
      }
    };
  }, [activeHoverToken, elementTokenTooltipId, quoteTokenTooltipId]);

  useLayoutEffect(() => {
    const composerRoot = composerRootRef.current;
    if (!composerRoot) return;

    const sync = () => syncTriggerMenuWidth(composerRoot);
    sync();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', sync);
      return () => window.removeEventListener('resize', sync);
    }

    const observer = new ResizeObserver(sync);
    observer.observe(composerRoot);
    return () => observer.disconnect();
  }, []);

  const pluginApi = useMemo(() => createPluginApi(transport), [transport]);
  const pluginControlApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );
  const { data: pluginCatalog } = useQuery({
    queryKey: ['session-composer-plugin-actions', transport.environment],
    queryFn: () => pluginApi.catalog(),
    staleTime: 5_000,
  });
  const { data: pluginControlCatalog } = useQuery({
    queryKey: ['session-composer-plugin-control', transport.environment],
    queryFn: () => pluginControlApi.catalog(),
    staleTime: 5_000,
  });
  const composerSlashContributions =
    usePluginHostContributions('composer_slash');
  const { data: agentSkills } = useQuery({
    queryKey: [
      'session-composer-agent-skills',
      transport.environment,
      executor,
      workspacePath,
    ],
    queryFn: () =>
      transport.call('list_agent_skills', {
        agentType: executor!,
        workspacePath: workspacePath ?? null,
      }) as Promise<AgentSkillsListResult>,
    enabled: executor === 'codex',
    staleTime: 0,
  });
  const hostedPluginSkillIds = useMemo(
    () => new Set(agentSkills?.skills.map((skill) => skill.id) ?? []),
    [agentSkills]
  );
  const localSkills = useMemo<AgentLocalSkill[]>(
    () =>
      (agentSkills?.skills ?? []).map((skill) => ({
        name: skill.id,
        description: skill.description,
        path: skill.path,
        invocation: executor === 'codex' ? `$${skill.id}` : `/${skill.id}`,
      })),
    [agentSkills, executor]
  );
  const allSlashCommands = useMemo(
    () =>
      mergeComposerSlashCommands({
        catalogCommands: [],
        runtimeCommands: agentAvailableCommandsToSlashCommands(
          availableCommands ?? []
        ),
        skillCommands: [],
        pluginCommands: [
          ...pluginInvocationsToSlashCommands(pluginControlCatalog),
          ...pluginComposerSlashContributions(composerSlashContributions),
        ],
      }),
    [availableCommands, composerSlashContributions, pluginControlCatalog]
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

  const liveCommandsReadyRef = useRef(!commandsLoading);
  liveCommandsReadyRef.current = !commandsLoading;
  const allSlashCommandsRef = useRef(allSlashCommands);
  allSlashCommandsRef.current = allSlashCommands;
  const executorRef = useRef(executor);
  executorRef.current = executor;
  const liveCommandsWaitersRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    if (commandsLoading) return;
    const waiters = liveCommandsWaitersRef.current;
    liveCommandsWaitersRef.current = [];
    waiters.forEach((resolve) => resolve());
  }, [commandsLoading]);

  const slashSource = useMemo<SearchSource>(
    () => ({
      search: async (query) => {
        if (!liveCommandsReadyRef.current) {
          await new Promise<void>((resolve) => {
            liveCommandsWaitersRef.current.push(resolve);
          });
        }
        return slashCommandsToTypeaheadOptions(
          allSlashCommandsRef.current,
          query,
          executorRef.current
        ).map(toSearchableItem);
      },
      bootstrap: async () => {
        if (!liveCommandsReadyRef.current) {
          await new Promise<void>((resolve) => {
            liveCommandsWaitersRef.current.push(resolve);
          });
        }
        return slashCommandsToTypeaheadOptions(
          allSlashCommandsRef.current,
          '',
          executorRef.current
        ).map(toSearchableItem);
      },
    }),
    []
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
  const makeToken = useCallback((item: SearchableItem): ChatComposerToken => {
    const data = item.auxiliaryData as ComposerSearchItemData | undefined;
    const insertText = data?.insertText ?? '';
    const token = getTokenFromInsertText(insertText);
    return {
      value: insertText,
      label: token?.label ?? item.label,
      variant: token ? SESSION_COMPOSER_TOKEN_VARIANTS[token.kind] : 'neutral',
      icon:
        token &&
        token.kind !== 'file' &&
        token.kind !== 'tag' &&
        token.kind !== 'conversation' &&
        token.kind !== 'commit' &&
        token.kind !== 'element' &&
        token.kind !== 'quote' ? (
          <SessionComposerTokenIcon token={token} />
        ) : undefined,
    };
  }, []);
  const pluginOnSelect = useCallback((item: SearchableItem): string => {
    const insertText =
      (item.auxiliaryData as { insertText?: string } | undefined)?.insertText ??
      '';
    return insertText;
  }, []);

  const renderItem = useCallback(
    (item: SearchableItem) => <ComposerTriggerMenuItem item={item} />,
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
      ...(agentMentions.capability === 'supported'
        ? [
            {
              character: '&' as const,
              searchSource: agentMentionSource,
              onSelect: makeToken,
              renderItem,
              loadingText: t('agentMention.loading'),
              emptySearchResultsText: t('agentMention.noMatches'),
            },
          ]
        : []),
      {
        character: '!',
        searchSource: pluginSource,
        onSelect: pluginOnSelect,
        renderItem,
        loadingText: t('pluginActions.loading'),
        emptySearchResultsText: t('pluginActions.noMatches'),
      },
    ],
    [
      agentMentionSource,
      agentMentions.capability,
      dollarSource,
      makeToken,
      pluginOnSelect,
      pluginSource,
      renderItem,
      slashSource,
      t,
    ]
  );

  // --- Programmatic token insertion (code selection, file-reference drop) ---

  const insertComposerTokenAtCaret = useCallback(
    (token: { value: string; label: string; variant?: 'cyan' }) => {
      const handle = composerHandleRef.current;
      if (!handle) {
        onChange(
          value.trim() ? `${value.trim()} ${token.value} ` : `${token.value} `
        );
        return;
      }
      prepareEmptyComposerForTokenInsert(
        getSessionComposerEditable(composerRootRef.current)
      );
      handle.insertToken({
        value: token.value,
        label: token.label,
        variant: token.variant,
      });
      onChange(handle.getValue());
    },
    [onChange, value]
  );

  const insertFileReferenceTokenAtCaret = useCallback(
    (relativePath: string) => {
      insertComposerTokenAtCaret({
        value: fileReferenceTokenText(relativePath),
        label: `@${getFileName(relativePath)}`,
      });
    },
    [insertComposerTokenAtCaret]
  );

  const insertStructuredTokenAtCaret = useCallback(
    (token: { value: string; label: string }) => {
      insertComposerTokenAtCaret({
        value: token.value,
        label: token.label,
        variant: 'cyan',
      });
      window.requestAnimationFrame(() => composerHandleRef.current?.focus());
    },
    [insertComposerTokenAtCaret]
  );

  useEffect(() => {
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<ComposerInsertDetail>).detail;
      if (!detail || detail.mode !== 'token' || !detail.text) return;
      insertStructuredTokenAtCaret({
        value: detail.text,
        label: detail.label ?? detail.text,
      });
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => {
      window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
    };
  }, [insertStructuredTokenAtCaret]);

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

  const handleHostDroppedPaths = useCallback(
    async (paths: string[]) => {
      if (disabled || paths.length === 0) return;
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const files: File[] = [];
      const otherPaths: string[] = [];
      for (const path of paths) {
        try {
          files.push(
            await fileFromHostPath(path, (filePath) => readFile(filePath))
          );
        } catch {
          otherPaths.push(path);
        }
      }
      if (files.length > 0) {
        onAttachImages(files.map(prepareImageFileForUpload));
      }
      for (const path of otherPaths) {
        const relative =
          relativePathInsideRoot(workspacePath, path) ?? hostPathFileName(path);
        if (!relative) continue;
        insertFileReferenceTokenAtCaret(relative);
      }
    },
    [disabled, insertFileReferenceTokenAtCaret, onAttachImages, workspacePath]
  );

  useEffect(() => {
    const root = composerRootRef.current;
    if (!root) return;
    const markCompositionEnd = () => {
      lastCompositionEndAtRef.current = performance.now();
    };
    root.addEventListener('compositionend', markCompositionEnd, true);
    return () => {
      root.removeEventListener('compositionend', markCompositionEnd, true);
    };
  }, []);

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
    if (disabled) {
      setComposerDropActive(false);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          const zone = dropZoneRef.current;
          if (payload.type === 'leave') {
            setComposerDropActive(false);
            return;
          }
          if (payload.type === 'enter' || payload.type === 'over') {
            setComposerDropActive(
              !!zone &&
                'position' in payload &&
                isPointInElement(zone, payload.position.x, payload.position.y)
            );
            return;
          }
          if (payload.type !== 'drop') return;
          const overZone =
            !!zone &&
            isPointInElement(zone, payload.position.x, payload.position.y);
          const accept = overZone || dropActiveRef.current;
          setComposerDropActive(false);
          if (!accept) return;
          void handleHostDroppedPaths(payload.paths);
        })
      )
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [disabled, handleHostDroppedPaths, setComposerDropActive]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      setComposerDropActive(false);
      const fileReference = getDroppedFileReference(event.dataTransfer);
      if (fileReference) {
        event.preventDefault();
        event.stopPropagation();
        insertDroppedFileReference(fileReference);
        return;
      }

      const files = attachableFilesFromFileList(event.dataTransfer.files);
      if (files.length === 0) return;

      event.preventDefault();
      onAttachImages(files);
    },
    [insertDroppedFileReference, onAttachImages, setComposerDropActive]
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (hasFileReferenceDrag(event.dataTransfer)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setComposerDropActive(true);
        return;
      }
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
        setComposerDropActive(true);
      }
    },
    [setComposerDropActive]
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) {
        return;
      }
      setComposerDropActive(false);
    },
    [setComposerDropActive]
  );

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) =>
      handleComposerImagePaste(event, onAttachImages, disabled),
    [disabled, onAttachImages]
  );

  useEffect(() => {
    historyIndexRef.current = -1;
    historyDraftRef.current = '';
    localSubmitsRef.current = [];
  }, [sessionId]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (text.trim()) {
        localSubmitsRef.current = [...localSubmitsRef.current, text];
      }
      historyIndexRef.current = -1;
      historyDraftRef.current = '';
      if (mentionedHostFileNames(text).length === 0) {
        onSubmit(text);
        return;
      }
      void (async () => {
        try {
          const submitted = await materializeMentionedHostFiles({ text });
          onSubmit(submitted);
        } catch (error) {
          toast.error(t('composer.atReference.materializeFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    [onSubmit, t]
  );

  const handleHistoryKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return false;
      if (!isComposerHistoryNavigationKey(event)) return false;

      const history = mergeComposerMessageHistory(
        messageHistory ?? [],
        localSubmitsRef.current
      );
      const editor = composerRootRef.current?.querySelector<HTMLElement>(
        '[contenteditable="true"], [contenteditable="false"][role="combobox"]'
      );
      if (
        !shouldNavigateComposerHistory({
          key: event.key,
          isBrowsing: historyIndexRef.current !== -1,
          isCaretAtStart: isComposerCaretAtDocumentStart(editor ?? null),
          historyLength: history.length,
        })
      ) {
        return false;
      }

      const next = stepComposerHistory({
        history,
        index: historyIndexRef.current,
        draft: historyDraftRef.current,
        currentValue: composerHandleRef.current?.getValue() ?? value,
        direction: event.key === 'ArrowUp' ? 'older' : 'newer',
      });
      if (!next.applied) return false;

      event.preventDefault();
      historyIndexRef.current = next.index;
      historyDraftRef.current = next.draft;
      onChange(next.value);
      queueMicrotask(() => atReference.detect());
      return true;
    },
    [atReference, disabled, messageHistory, onChange, value]
  );

  return (
    <div
      ref={dropZoneRef}
      className="session-composer-file-drop-zone min-w-0"
      data-file-reference-drop-zone
      data-testid="session-composer-file-drop-zone"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropActive ? (
        <div
          className="session-composer-drop-overlay"
          role="status"
          aria-label={t('composer.dropFiles')}
        >
          <FolderOpen aria-hidden="true" />
          <strong>{t('composer.dropFiles')}</strong>
        </div>
      ) : null}
      <div
        className={cn(
          'min-h-[40px] rounded-lg bg-background/35 px-1.5 pb-1 pt-0 transition-colors focus-within:bg-background/50',
          disabled && 'opacity-60'
        )}
        data-testid="session-composer-input-surface"
        onPointerOver={handleTokenPointerOver}
        onPointerOut={handleTokenPointerOut}
        onFocusCapture={handleTokenFocus}
        onBlurCapture={handleTokenBlur}
      >
        <ChatComposerInput
          ref={composerRootRef}
          value={value}
          onChange={(next) => {
            onChange(next);
            queueMicrotask(() => atReference.detect());
          }}
          isDisabled={disabled}
          className={cn(
            'session-composer-editor min-h-[32px] w-full px-0.5 pb-1 pt-0 font-sans subpixel-antialiased text-[13px] leading-5 tracking-[0.005em]',
            className
          )}
          maxRows={7}
          placeholder=""
          label={t('composer.inputLabel')}
          hasHistory={false}
          pasteAsToken={false}
          triggers={triggers}
          handleRef={composerHandleRef}
          onKeyDown={(event) => {
            if (
              isComposerImeCommitEnter(event, lastCompositionEndAtRef.current)
            ) {
              return;
            }
            if (atReference.handleKeyDown(event)) {
              return;
            }
            if (handleHistoryKeyDown(event)) {
              return;
            }
            const action = composerEnterAction(
              sendShortcut,
              event,
              lastCompositionEndAtRef.current
            );
            if (action === 'defer') return;
            event.preventDefault();
            if (action === 'newline') {
              composerHandleRef.current?.insertText('\n');
              return;
            }
            const text = composerHandleRef.current?.getValue().trim() ?? '';
            if (!text) return;
            handleSubmit(text);
            const editable =
              composerRootRef.current?.querySelector<HTMLElement>(
                '[contenteditable="true"]'
              );
            if (editable) editable.textContent = '';
            onChange('');
          }}
          onSubmit={handleSubmit}
          onFiles={(files) => {
            const attached = files
              .filter(isAttachableFile)
              .map(prepareImageFileForUpload);
            if (attached.length > 0) onAttachImages(attached);
          }}
          onPaste={handleComposerPaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          data-testid="session-composer-editor"
        />
        {activeHoverToken?.token.kind === 'element' ? (
          <PreviewElementTokenTooltip
            anchor={activeHoverToken.anchor}
            id={elementTokenTooltipId}
            token={activeHoverToken.token}
          />
        ) : null}
        {activeHoverToken?.token.kind === 'quote' ? (
          <QuoteTokenPreview
            anchor={activeHoverToken.anchor}
            id={quoteTokenTooltipId}
            text={activeHoverToken.token.value}
            onPointerEnter={cancelHoverHide}
            onPointerLeave={() => hideTokenHover(activeHoverToken.anchor, 120)}
          />
        ) : null}
      </div>
      {atReference.panel ? (
        <ComposerAtReferencePanel
          groups={atReference.panel.groups}
          activeTab={atReference.panel.activeTab}
          selectedIndex={atReference.panel.selectedIndex}
          loading={atReference.panel.loading}
          left={atReference.panel.left}
          top={atReference.panel.top}
          width={atReference.panel.width}
          onSelectTab={atReference.selectTab}
          onSelectItem={atReference.selectItem}
          onHighlight={atReference.highlight}
        />
      ) : null}
    </div>
  );
}
