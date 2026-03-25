import { Diff } from 'shared/types';
import { DiffModeEnum, DiffView, SplitSide } from '@git-diff-view/react';
import { generateDiffFile, type DiffFile } from '@git-diff-view/file';
import { useMemo, useState, useCallback, useEffect } from 'react';
import { useUserSystem } from '@/components/ConfigProvider';
import { getHighLightLanguageFromPath } from '@/utils/extToLanguage';
import { getActualTheme } from '@/utils/theme';
import { stripLineEnding } from '@/utils/string';
import { Button } from '@/components/ui/button';
import { DiffSide } from '@/types/diff';
import {
  ChevronRight,
  ChevronUp,
  Trash2,
  ArrowLeftRight,
  FilePlus2,
  PencilLine,
  Copy,
  Key,
  ExternalLink,
  MessageSquare,
  Loader2,
} from 'lucide-react';
import '@/styles/diff-style-overrides.css';
import { attemptsApi, fileTreeApi } from '@/lib/api';
import type { Workspace } from 'shared/types';
import {
  useReview,
  type ReviewDraft,
  type ReviewComment,
} from '@/contexts/ReviewProvider';
import { CommentWidgetLine } from '@/components/diff/CommentWidgetLine';
import { ReviewCommentRenderer } from '@/components/diff/ReviewCommentRenderer';
import {
  useDiffViewMode,
  useIgnoreWhitespaceDiff,
  useWrapTextDiff,
} from '@/stores/useDiffViewStore';
import { useProject } from '@/contexts/ProjectContext';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';

type Props = {
  diff: Diff;
  expanded: boolean;
  onToggle: () => void;
  selectedAttempt: Workspace | null;
};

function isAbsolutePath(path: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith('/') ||
    path.startsWith('\\\\')
  );
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function joinPath(basePath: string, relativePath: string): string {
  const normalizedBase = basePath.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/^[/\\]+/, '');
  return `${normalizedBase}/${normalizedRelative}`;
}

function buildRelativePathVariants(relativePath: string): string[] {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return [];

  const variants = [normalized];
  const firstSlash = normalized.indexOf('/');
  if (firstSlash > 0 && firstSlash < normalized.length - 1) {
    variants.push(normalized.slice(firstSlash + 1));
  }

  return [...new Set(variants)];
}

function labelAndIcon(diff: Diff) {
  const c = diff.change;
  if (c === 'deleted') return { label: 'Deleted', Icon: Trash2 };
  if (c === 'renamed') return { label: 'Renamed', Icon: ArrowLeftRight };
  if (c === 'added')
    return { label: undefined as string | undefined, Icon: FilePlus2 };
  if (c === 'copied') return { label: 'Copied', Icon: Copy };
  if (c === 'permissionChange')
    return { label: 'Permission Changed', Icon: Key };
  return { label: undefined as string | undefined, Icon: PencilLine };
}

function readPlainLine(
  diffFile: DiffFile | null,
  lineNumber: number,
  side: DiffSide
) {
  if (!diffFile) return undefined;
  try {
    const rawLine =
      side === DiffSide.Old
        ? diffFile.getOldPlainLine(lineNumber)
        : diffFile.getNewPlainLine(lineNumber);
    if (rawLine?.value === undefined) return undefined;
    return stripLineEnding(rawLine.value);
  } catch (error) {
    console.error('Failed to read line content for review comment', error);
    return undefined;
  }
}

export default function DiffCard({
  diff,
  expanded,
  onToggle,
  selectedAttempt,
}: Props) {
  const { config } = useUserSystem();
  const theme = getActualTheme(config?.theme);
  const { comments, drafts, setDraft } = useReview();
  const globalMode = useDiffViewMode();
  const ignoreWhitespace = useIgnoreWhitespaceDiff();
  const wrapText = useWrapTextDiff();
  const { projectId } = useProject();
  const panelActions = useOptionalPanelActionsContext();

  const oldName = diff.oldPath || undefined;
  const newName = diff.newPath || oldName || 'unknown';
  const oldLang =
    getHighLightLanguageFromPath(oldName || newName || '') || 'plaintext';
  const newLang =
    getHighLightLanguageFromPath(newName || oldName || '') || 'plaintext';
  const { label, Icon } = labelAndIcon(diff);
  const isOmitted = !!diff.contentOmitted;
  const requiresOldContent = diff.change !== 'added';
  const requiresNewContent = diff.change !== 'deleted';
  const isMissingRequiredContent =
    (requiresOldContent && diff.oldContent === null) ||
    (requiresNewContent && diff.newContent === null);
  const hasStatChanges = (diff.additions ?? 0) + (diff.deletions ?? 0) > 0;
  const isLikelyMissingPayloadContent =
    !isOmitted &&
    hasStatChanges &&
    (diff.oldContent ?? '') === '' &&
    (diff.newContent ?? '') === '' &&
    diff.change !== 'added' &&
    diff.change !== 'deleted';
  const shouldLoadContent =
    isOmitted || isMissingRequiredContent || isLikelyMissingPayloadContent;

  // State for force-loading omitted content
  const [forcedOldContent, setForcedOldContent] = useState<string | null>(null);
  const [forcedNewContent, setForcedNewContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  const handleLoadContent = useCallback(async () => {
    setIsLoadingContent(true);
    try {
      const basePaths: string[] = [];
      const containerRef = selectedAttempt?.container_ref?.trim();
      if (containerRef) {
        basePaths.push(containerRef);
      }
      const agentWorkingDir = selectedAttempt?.agent_working_dir?.trim();
      if (agentWorkingDir) {
        if (isAbsolutePath(agentWorkingDir)) {
          basePaths.push(agentWorkingDir);
        } else if (containerRef) {
          basePaths.push(joinPath(containerRef, agentWorkingDir));
        } else {
          basePaths.push(agentWorkingDir);
        }
      }
      const uniqueBasePaths = [...new Set(basePaths)];
      // The HEAD path: for renamed/copied use oldPath; for all others use newPath
      // (modified files have oldPath=null but the HEAD version lives at newPath)
      const headRelPath = diff.oldPath || diff.newPath;
      // The working-tree path is always newPath (or oldPath for deleted)
      const wtRelPath = diff.newPath || diff.oldPath;
      const loadFromCandidates = async (
        relativePath: string,
        loader: (absolutePath: string) => Promise<string>
      ): Promise<string | null> => {
        const relativeVariants = buildRelativePathVariants(relativePath);
        for (const basePath of uniqueBasePaths) {
          for (const relativeVariant of relativeVariants) {
            const absolutePath = joinPath(basePath, relativeVariant);
            try {
              return await loader(absolutePath);
            } catch {
              // Try next candidate path.
            }
          }
        }
        return null;
      };

      // Load new (working tree) content — empty for deleted files
      if (wtRelPath && diff.change !== 'deleted') {
        const newContent =
          uniqueBasePaths.length > 0
            ? await loadFromCandidates(wtRelPath, (path) =>
                fileTreeApi.readFile(path)
              )
            : null;
        setForcedNewContent(newContent ?? '');
      } else {
        setForcedNewContent('');
      }
      // Load old (HEAD) content — empty for added files
      if (headRelPath && diff.change !== 'added') {
        const oldContent =
          uniqueBasePaths.length > 0
            ? await loadFromCandidates(headRelPath, (path) =>
                fileTreeApi.getFileAtHead(path)
              )
            : null;
        setForcedOldContent(oldContent ?? '');
      } else {
        setForcedOldContent('');
      }
    } catch {
      setForcedOldContent('');
      setForcedNewContent('');
    } finally {
      setIsLoadingContent(false);
    }
  }, [diff, selectedAttempt]);

  // Auto-load content when omitted or missing in stream payload and card is expanded
  useEffect(() => {
    if (
      expanded &&
      shouldLoadContent &&
      forcedOldContent === null &&
      forcedNewContent === null &&
      !isLoadingContent
    ) {
      handleLoadContent();
    }
  }, [
    expanded,
    forcedNewContent,
    forcedOldContent,
    handleLoadContent,
    isLoadingContent,
    shouldLoadContent,
  ]);

  // Build a diff from raw contents so the viewer can expand beyond hunks.
  // If content was force-loaded, use that instead of stream payload content.
  const oldContentSafe =
    shouldLoadContent && forcedOldContent !== null
      ? forcedOldContent
      : (diff.oldContent ?? '');
  const newContentSafe =
    shouldLoadContent && forcedNewContent !== null
      ? forcedNewContent
      : (diff.newContent ?? '');

  const diffOptions = useMemo(
    () => (ignoreWhitespace ? { ignoreWhitespace: true as const } : undefined),
    [ignoreWhitespace]
  );

  // Treat both omitted and missing-payload content as omitted until we force-load it.
  const isEffectivelyOmitted =
    shouldLoadContent &&
    forcedOldContent === null &&
    forcedNewContent === null;
  const isContentEqual = !isEffectivelyOmitted && oldContentSafe === newContentSafe;

  const diffFile = useMemo(() => {
    if (isEffectivelyOmitted) return null;
    if (isContentEqual) return null;
    try {
      const oldFileName = oldName || newName || 'unknown';
      const newFileName = newName || oldName || 'unknown';
      const file = generateDiffFile(
        oldFileName,
        oldContentSafe,
        newFileName,
        newContentSafe,
        oldLang,
        newLang,
        diffOptions
      );
      file.initRaw();
      return file;
    } catch (e) {
      console.error('Failed to build diff for view', e);
      return null;
    }
  }, [
    isContentEqual,
    isEffectivelyOmitted,
    oldName,
    newName,
    oldLang,
    newLang,
    oldContentSafe,
    newContentSafe,
    diffOptions,
  ]);

  const add = isEffectivelyOmitted
    ? (diff.additions ?? 0)
    : (diffFile?.additionLength ?? 0);
  const del = isEffectivelyOmitted
    ? (diff.deletions ?? 0)
    : (diffFile?.deletionLength ?? 0);

  // Review functionality
  const filePath = newName || oldName || 'unknown';
  const commentsForFile = useMemo(
    () => comments.filter((c) => c.filePath === filePath),
    [comments, filePath]
  );

  // Transform comments to git-diff-view extendData format
  const extendData = useMemo(() => {
    const oldFileData: Record<string, { data: ReviewComment }> = {};
    const newFileData: Record<string, { data: ReviewComment }> = {};

    commentsForFile.forEach((comment) => {
      const lineKey = String(comment.lineNumber);
      if (comment.side === DiffSide.Old) {
        oldFileData[lineKey] = { data: comment };
      } else {
        newFileData[lineKey] = { data: comment };
      }
    });

    return {
      oldFile: oldFileData,
      newFile: newFileData,
    };
  }, [commentsForFile]);

  const handleAddWidgetClick = (lineNumber: number, side: SplitSide) => {
    const diffSide = side === SplitSide.old ? DiffSide.Old : DiffSide.New;
    const widgetKey = `${filePath}-${diffSide}-${lineNumber}`;
    const codeLine = readPlainLine(diffFile, lineNumber, diffSide);
    const draft: ReviewDraft = {
      filePath,
      side: diffSide,
      lineNumber,
      text: '',
      ...(codeLine !== undefined ? { codeLine } : {}),
    };
    setDraft(widgetKey, draft);
  };

  const renderWidgetLine = (props: {
    side: SplitSide;
    lineNumber: number;
    onClose: () => void;
  }) => {
    const diffSide = props.side === SplitSide.old ? DiffSide.Old : DiffSide.New;
    const widgetKey = `${filePath}-${diffSide}-${props.lineNumber}`;
    const draft = drafts[widgetKey];
    if (!draft) return null;

    return (
      <CommentWidgetLine
        draft={draft}
        widgetKey={widgetKey}
        onSave={props.onClose}
        onCancel={props.onClose}
        projectId={projectId}
      />
    );
  };

  const renderExtendLine = (lineData: { data: ReviewComment }) => {
    return (
      <ReviewCommentRenderer comment={lineData.data} projectId={projectId} />
    );
  };

  // Title row
  const title = (
    <div className="flex items-center gap-2 flex-1 min-w-0 text-sm font-mono">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      {label && <span className="text-muted-foreground/60 text-xs shrink-0">{label}</span>}
      {diff.change === 'renamed' && oldName ? (
        <span className="flex items-center gap-1.5 truncate text-foreground/80">
          <span className="truncate">{oldName}</span>
          <span className="text-muted-foreground/50 shrink-0" aria-hidden>→</span>
          <span className="truncate">{newName}</span>
        </span>
      ) : (
        <span className="truncate text-foreground/80">{newName}</span>
      )}
      <span className="shrink-0 flex items-center gap-1.5 ml-1 font-mono text-xs">
        <span className="text-green-600 dark:text-green-500">+{add}</span>
        <span className="text-red-600 dark:text-red-500">-{del}</span>
      </span>
      {commentsForFile.length > 0 && (
        <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-primary/10 text-primary rounded">
          <MessageSquare className="h-3 w-3" />
          {commentsForFile.length}
        </span>
      )}
    </div>
  );

  const handleOpenDiffInTab = async () => {
    const openPath =
      diff.change === 'deleted'
        ? (oldName ?? newName)
        : (newName ?? oldName);

    if (!openPath) return;

    const diffViewMode = globalMode === 'unified' ? 'inline' : 'split';

    if (panelActions?.openDiffPreviewAtPath) {
      const fileName = (newName || oldName || openPath).split(/[/\\]/).pop() || openPath;
      panelActions.openDiffPreviewAtPath(openPath, {
        title: `◐ ${fileName}`,
        diffViewMode,
        originalContent: oldContentSafe,
        modifiedContent: newContentSafe,
      });
      return;
    }

    if (!selectedAttempt?.id) return;

    try {
      const response = await attemptsApi.openEditor(selectedAttempt.id, {
        editor_type: null,
        file_path: openPath,
      });

      if (response.url) {
        window.open(response.url, '_blank');
      }
    } catch (err) {
      console.error('Failed to open diff in tab:', err);
    }
  };

  const expandable = true;

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
      <div className="sticky top-0 z-[5] flex items-center border-b border-border/70 bg-muted/20 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        {expandable && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            className="h-6 w-6 p-0 mr-2"
            title={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </Button>
        )}
        {title}
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            handleOpenDiffInTab();
          }}
          className="h-6 w-6 p-0 ml-2"
          title="Open diff in tab"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
        </Button>
      </div>

      {expanded && diffFile && (
        <div>
          <DiffView
            diffFile={diffFile}
            diffViewWrap={wrapText}
            diffViewTheme={theme}
            diffViewHighlight
            diffViewMode={
              globalMode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified
            }
            diffViewFontSize={12}
            diffViewAddWidget
            onAddWidgetClick={handleAddWidgetClick}
            renderWidgetLine={renderWidgetLine}
            extendData={extendData}
            renderExtendLine={renderExtendLine}
          />
        </div>
      )}
      {expanded && !diffFile && (
        <div
          className="px-4 pb-4 pt-2 text-xs font-mono"
          style={{ color: 'hsl(var(--muted-foreground) / 0.9)' }}
        >
          {isEffectivelyOmitted
            ? (
              <div className="flex items-center justify-center gap-2 py-6">
                {isLoadingContent ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">加载文件内容中…</span>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-sm text-muted-foreground">内容加载失败</p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleLoadContent}
                        className="h-7 text-xs"
                      >
                        重新加载
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleOpenDiffInTab}
                        className="h-7 text-xs"
                      >
                        在标签页中打开
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
            : isContentEqual
              ? diff.change === 'renamed'
                ? 'File renamed with no content changes.'
                : diff.change === 'permissionChange'
                  ? 'File permission changed.'
                  : 'No content changes to display.'
              : 'Failed to render diff for this file.'}
        </div>
      )}
    </div>
  );
}
