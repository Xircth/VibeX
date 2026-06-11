import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Check,
  ChevronDown,
  Clipboard,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Undo2,
} from 'lucide-react';
import WYSIWYGEditor, {
  SESSION_INPUT_MARKDOWN_PRESET,
  SESSION_INPUT_TEXT_CLASS_NAME,
} from '@/components/ui/wysiwyg';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { AgentCapability } from '@/lib/api/config';
import type { WorkspaceWithSession } from '@/types/attempt';
import { useUserSystem } from '@/components/ConfigProvider';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useAttemptExecution } from '@/hooks/useAttemptExecution';
import { useBranchStatus } from '@/hooks/useBranchStatus';
import { useImageMetadata } from '@/hooks/useImageMetadata';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { fileTreeApi, sessionsApi } from '@/lib/api';
import { RestoreLogsDialog } from '@/components/dialogs';
import { RetryEditorInline } from './RetryEditorInline';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  getContinuityActionCopy,
  getExecutorContinuityMode,
} from '@/utils/sessionContinuity';
import { stripTagReferenceAppendix } from '@/lib/tagReferenceMarkers';
import { SessionComposerStructuredText } from '@/components/tasks/follow-up/SessionComposerStructuredText';
import { getSessionComposerStructuredTokenSegments } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';

const COLLAPSED_MAX_HEIGHT = 120;
const EXPANDED_BOTTOM_SAFE_SPACE = 28;
const MAX_USER_MESSAGE_IMAGE_URL_CACHE = 100;
const MAX_USER_MESSAGE_THUMBNAIL_CACHE = 100;
const USER_MESSAGE_THUMBNAIL_SIZE = 160;
const VIBE_IMAGE_MARKDOWN_PATTERN =
  /!\[([^\]]*)\]\((\.vibe-images\/[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

const userMessageImageUrlCache = new Map<string, string>();
const userMessageImageUrlRequests = new Map<string, Promise<string>>();
const userMessageThumbnailCache = new Map<string, string>();
const userMessageThumbnailRequests = new Map<string, Promise<string | null>>();

type UserMessageImage = {
  id: string;
  path: string;
  altText: string;
};

function splitDisplayContentImages(content: string): {
  text: string;
  images: UserMessageImage[];
} {
  const images: UserMessageImage[] = [];
  const text = content
    .replace(VIBE_IMAGE_MARKDOWN_PATTERN, (_match, altText, imagePath) => {
      const path = String(imagePath ?? '').trim();
      if (!path) return '';

      images.push({
        id: `${path}:${images.length}`,
        path,
        altText: String(altText ?? '').trim() || 'Image',
      });

      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, images };
}

function rememberUserMessageImageUrl(path: string, url: string) {
  userMessageImageUrlCache.delete(path);
  userMessageImageUrlCache.set(path, url);

  while (userMessageImageUrlCache.size > MAX_USER_MESSAGE_IMAGE_URL_CACHE) {
    const oldestKey = userMessageImageUrlCache.keys().next().value;
    if (!oldestKey) break;
    userMessageImageUrlCache.delete(oldestKey);
  }
}

function getCachedUserMessageImageUrl(path: string): string | null {
  return userMessageImageUrlCache.get(path) ?? null;
}

function rememberUserMessageThumbnail(path: string, url: string) {
  userMessageThumbnailCache.delete(path);
  userMessageThumbnailCache.set(path, url);

  while (userMessageThumbnailCache.size > MAX_USER_MESSAGE_THUMBNAIL_CACHE) {
    const oldestKey = userMessageThumbnailCache.keys().next().value;
    if (!oldestKey) break;
    userMessageThumbnailCache.delete(oldestKey);
  }
}

function getCachedUserMessageThumbnail(path: string): string | null {
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
  const [cachedImageUrl, setCachedImageUrl] = useState<string | null>(() =>
    getCachedUserMessageImageUrl(image.path)
  );
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(() =>
    getCachedUserMessageThumbnail(image.path)
  );
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const imageUrl = cachedImageUrl ?? metadata?.proxy_url;
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

    ImagePreviewDialog.show({
      imageUrl,
      altText: label,
      fileName: metadata?.file_name ?? label,
      format: metadata?.format ?? undefined,
      sizeBytes: metadata?.size_bytes,
    });
  }, [imageLoadFailed, imageUrl, label, metadata]);

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

const UserMessage = ({
  content,
  executionProcessId,
  taskAttempt,
}: {
  content: string;
  executionProcessId?: string;
  taskAttempt?: WorkspaceWithSession;
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const [isCollapseMeasured, setIsCollapseMeasured] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [copied, triggerCopied] = useTemporaryFlag(400);

  const { capabilities } = useUserSystem();
  const { activeRetryProcessId, setActiveRetryProcessId, isProcessGreyed } =
    useRetryUi();
  const { isAttemptRunning } = useAttemptExecution(taskAttempt?.id);
  const { data: branchStatus } = useBranchStatus(taskAttempt?.id);
  const continuityCopy = getContinuityActionCopy(
    getExecutorContinuityMode(taskAttempt?.session?.executor ?? null)
  );
  const displayContent = stripTagReferenceAppendix(content);
  const { text: displayText, images: displayImages } = useMemo(
    () => splitDisplayContentImages(displayContent),
    [displayContent]
  );
  const structuredSegments = useMemo(
    () => getSessionComposerStructuredTokenSegments(displayText),
    [displayText]
  );
  const hasStructuredTokens = structuredSegments.some(
    (segment) => segment.kind === 'token'
  );

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const check = () => {
      setNeedsCollapse(element.scrollHeight > COLLAPSED_MAX_HEIGHT);
      setIsCollapseMeasured(true);
    };

    check();

    const resizeObserver = new ResizeObserver(() => {
      check();
    });

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [displayText]);

  const canFork = !!(
    taskAttempt?.session?.executor &&
    capabilities?.[taskAttempt.session.executor]?.includes(
      AgentCapability.SESSION_FORK
    )
  );

  const startRetry = useCallback(() => {
    if (!executionProcessId || !taskAttempt) return;
    setIsEditing(true);
    setActiveRetryProcessId(executionProcessId);
  }, [executionProcessId, setActiveRetryProcessId, taskAttempt]);

  const onCancelled = useCallback(() => {
    setIsEditing(false);
    setActiveRetryProcessId(null);
  }, [setActiveRetryProcessId]);

  const showRetryEditor =
    !!executionProcessId &&
    isEditing &&
    activeRetryProcessId === executionProcessId;
  const greyed =
    !!executionProcessId &&
    isProcessGreyed(executionProcessId) &&
    !showRetryEditor;

  const canRetry = !!executionProcessId && canFork && !isAttemptRunning;
  const showActionRail = displayContent.trim().length > 0 || canRetry;
  const hasTextBubble = displayText.trim().length > 0;

  const handleCopy = useCallback(async () => {
    if (!displayContent) return;

    try {
      await writeClipboardViaBridge(displayContent.replace(/\\_/g, '_'));
      triggerCopied();
    } catch {
      // Ignore clipboard failures in embedded environments.
    }
  }, [displayContent, triggerCopied]);

  const handleRollback = useCallback(async () => {
    if (!executionProcessId || !taskAttempt?.session?.id) return;

    setIsRollingBack(true);
    try {
      let modalResult;
      try {
        modalResult = await RestoreLogsDialog.show({
          executionProcessId,
          branchStatus,
          processes: [],
          mode: 'reset',
        });
      } catch {
        return;
      }

      if (!modalResult || modalResult.action !== 'confirmed') return;

      await sessionsApi.reset(taskAttempt.session.id, {
        process_id: executionProcessId,
        force_when_dirty: modalResult.forceWhenDirty ?? false,
        perform_git_reset: modalResult.performGitReset ?? true,
      });
    } catch (error) {
      console.error('Failed to rollback:', error);
    } finally {
      setIsRollingBack(false);
    }
  }, [branchStatus, executionProcessId, taskAttempt]);

  if (showRetryEditor && taskAttempt) {
    return (
      <div className="py-2 px-3">
        <div className="flex justify-end">
          <div className="conv-user-retry-panel">
            <RetryEditorInline
              attempt={taskAttempt}
              executionProcessId={executionProcessId}
              initialContent={displayContent}
              onCancelled={onCancelled}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`py-1.5 px-3 ${greyed ? 'opacity-50 pointer-events-none' : ''}`}
    >
      <div className="flex justify-end group">
        <div className="flex w-full max-w-full flex-col items-end gap-1.5">
          {displayImages.length > 0 && (
            <div className="flex max-w-[min(520px,calc(100vw-4rem))] flex-wrap justify-end gap-2">
              {displayImages.map((image) => (
                <UserMessageImageAttachment
                  key={image.id}
                  image={image}
                  taskAttemptId={taskAttempt?.id}
                />
              ))}
            </div>
          )}

          {hasTextBubble && (
            <div className="conv-user-bubble relative">
              <div
                ref={contentRef}
                className="conv-user-collapsible"
                style={{
                  maxHeight:
                    isCollapsed && needsCollapse
                      ? `${COLLAPSED_MAX_HEIGHT}px`
                      : undefined,
                  paddingBottom:
                    !isCollapsed && needsCollapse
                      ? `${EXPANDED_BOTTOM_SAFE_SPACE}px`
                      : undefined,
                }}
              >
                {hasStructuredTokens ? (
                  <SessionComposerStructuredText
                    segments={structuredSegments}
                    className={`${SESSION_INPUT_TEXT_CLASS_NAME} whitespace-pre-wrap break-words`}
                    data-testid="user-message-structured-tokens"
                  />
                ) : (
                  <WYSIWYGEditor
                    value={displayText}
                    disabled
                    className={SESSION_INPUT_TEXT_CLASS_NAME}
                    markdownPreset={SESSION_INPUT_MARKDOWN_PRESET}
                    taskAttemptId={taskAttempt?.id}
                    hideReadOnlyActions
                  />
                )}
                {isCollapseMeasured && needsCollapse && isCollapsed && (
                  <div className="conv-user-collapsible-overlay" />
                )}
              </div>

              {isCollapseMeasured && needsCollapse && (
                <button
                  className="conv-user-toggle"
                  title={isCollapsed ? '查看完整消息' : '收起消息'}
                  aria-label={isCollapsed ? '查看完整消息' : '收起消息'}
                  onClick={() => setIsCollapsed((value) => !value)}
                >
                  <ChevronDown
                    className={`h-3 w-3 conv-user-toggle-icon ${!isCollapsed ? 'is-expanded' : ''}`}
                  />
                </button>
              )}

              {showActionRail && (
                <div className="absolute right-full top-2 mr-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={handleCopy}
                    className="p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                    title={copied ? 'Copied!' : 'Copy as Markdown'}
                    aria-label={copied ? 'Copied!' : 'Copy as Markdown'}
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5 text-green-600" />
                    ) : (
                      <Clipboard className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {canRetry && (
                    <button
                      onClick={startRetry}
                      className="p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                      title={continuityCopy.retryLabel}
                      aria-label={continuityCopy.retryLabel}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {canRetry && (
                    <button
                      onClick={handleRollback}
                      disabled={isRollingBack}
                      className="p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                      title="回滚到此处"
                      aria-label="回滚到此处"
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserMessage;
