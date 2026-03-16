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

type Props = {
  diff: Diff;
  expanded: boolean;
  onToggle: () => void;
  selectedAttempt: Workspace | null;
};

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

  const oldName = diff.oldPath || undefined;
  const newName = diff.newPath || oldName || 'unknown';
  const oldLang =
    getHighLightLanguageFromPath(oldName || newName || '') || 'plaintext';
  const newLang =
    getHighLightLanguageFromPath(newName || oldName || '') || 'plaintext';
  const { label, Icon } = labelAndIcon(diff);
  const isOmitted = !!diff.contentOmitted;

  // State for force-loading omitted content
  const [forcedOldContent, setForcedOldContent] = useState<string | null>(null);
  const [forcedNewContent, setForcedNewContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);

  const handleLoadContent = useCallback(async () => {
    if (!selectedAttempt?.agent_working_dir) return;
    const workdir = selectedAttempt.agent_working_dir;
    setIsLoadingContent(true);
    try {
      const sep = workdir.endsWith('/') || workdir.endsWith('\\') ? '' : '/';
      // The HEAD path: for renamed/copied use oldPath; for all others use newPath
      // (modified files have oldPath=null but the HEAD version lives at newPath)
      const headRelPath = diff.oldPath || diff.newPath;
      // The working-tree path is always newPath (or oldPath for deleted)
      const wtRelPath = diff.newPath || diff.oldPath;

      // Load new (working tree) content — empty for deleted files
      if (wtRelPath && diff.change !== 'deleted') {
        const absNew = `${workdir}${sep}${wtRelPath}`;
        const newContent = await fileTreeApi.readFile(absNew).catch(() => '');
        setForcedNewContent(newContent);
      } else {
        setForcedNewContent('');
      }
      // Load old (HEAD) content — empty for added files
      if (headRelPath && diff.change !== 'added') {
        const absOld = `${workdir}${sep}${headRelPath}`;
        const oldContent = await fileTreeApi.getFileAtHead(absOld).catch(() => '');
        setForcedOldContent(oldContent);
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

  // Auto-load content when omitted and card is expanded
  useEffect(() => {
    if (expanded && isOmitted && forcedOldContent === null && forcedNewContent === null && !isLoadingContent) {
      handleLoadContent();
    }
  }, [expanded, isOmitted, forcedOldContent, forcedNewContent, isLoadingContent, handleLoadContent]);

  // Build a diff from raw contents so the viewer can expand beyond hunks
  // If content was force-loaded, use that instead of the omitted content
  const oldContentSafe = (isOmitted && forcedOldContent !== null) ? forcedOldContent : (diff.oldContent || '');
  const newContentSafe = (isOmitted && forcedNewContent !== null) ? forcedNewContent : (diff.newContent || '');
  const isContentEqual = oldContentSafe === newContentSafe;

  const diffOptions = useMemo(
    () => (ignoreWhitespace ? { ignoreWhitespace: true as const } : undefined),
    [ignoreWhitespace]
  );

  // When content is omitted but we've force-loaded it, treat as not omitted for diffFile
  const isEffectivelyOmitted = isOmitted && forcedOldContent === null && forcedNewContent === null;

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

  const handleOpenInIDE = async () => {
    if (!selectedAttempt?.id) return;
    try {
      const openPath = newName || oldName;
      const response = await attemptsApi.openEditor(selectedAttempt.id, {
        editor_type: null,
        file_path: openPath ?? null,
      });

      // If a URL is returned, open it in a new window/tab
      if (response.url) {
        window.open(response.url, '_blank');
      }
    } catch (err) {
      console.error('Failed to open file in IDE:', err);
    }
  };

  const expandable = true;

  return (
    <div className="my-4 border">
      <div className="sticky top-0 z-[5] flex items-center px-4 py-2 bg-background border-b">
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
            handleOpenInIDE();
          }}
          className="h-6 w-6 p-0 ml-2"
          title="Open in IDE"
          disabled={diff.change === 'deleted'}
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
          className="px-4 pb-4 text-xs font-mono"
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
                        onClick={handleOpenInIDE}
                        className="h-7 text-xs"
                      >
                        在编辑器中打开
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
