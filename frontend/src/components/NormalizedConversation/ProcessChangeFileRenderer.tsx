import { useMemo, type CSSProperties, type MouseEvent } from 'react';
import { type FileChange } from 'shared/types';
import {
  ArrowRight,
  ChevronRight,
  Edit,
  FileClock,
  FilePlus2,
  FileX,
  Trash2,
} from 'lucide-react';
import {
  DiffLineType,
  DiffModeEnum,
  DiffView,
  parseInstance,
} from '@git-diff-view/react';
import { useUserSystem } from '@/components/ConfigProvider';
import { getHighLightLanguageFromPath } from '@/utils/extToLanguage';
import { getActualTheme } from '@/utils/theme';
import { useFileAtHead } from '@/hooks/useFileContent';
import { useExpandable } from '@/stores/useExpandableStore';
import { cn } from '@/lib/utils';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { getFilePreviewKind } from '@/utils/filePreviewKind';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import FileContentView from './FileContentView';
import '@/styles/diff-style-overrides.css';
import '@/styles/edit-diff-overrides.css';

type Props = {
  path: string;
  change: FileChange;
  expansionKey: string;
  defaultExpanded?: boolean;
  statusAppearance?: 'default' | 'denied' | 'timed_out';
  forceExpanded?: boolean;
  containerRef?: string | null;
};

const flatDiffSurfaceStyle = {
  '--diffs-bg': 'transparent',
  '--diffs-dark-bg': 'transparent',
  '--diffs-bg-context-override': 'transparent',
  '--diffs-bg-hover-override': 'transparent',
  '--diff-plain-content--': 'transparent',
  '--diff-expand-content--': 'transparent',
  '--diff-hunk-content--': 'transparent',
  '--diff-hunk-lineNumber--': 'transparent',
  '--diff-plain-lineNumber--': 'transparent',
} as CSSProperties;

function isWrite(
  change: FileChange
): change is Extract<FileChange, { action: 'write'; content: string }> {
  return change?.action === 'write';
}

function isDelete(
  change: FileChange
): change is Extract<FileChange, { action: 'delete' }> {
  return change?.action === 'delete';
}

function isRename(
  change: FileChange
): change is Extract<FileChange, { action: 'rename'; new_path: string }> {
  return change?.action === 'rename';
}

function isEdit(
  change: FileChange
): change is Extract<FileChange, { action: 'edit' }> {
  return change?.action === 'edit';
}

function resolveFilePath(
  filePath: string,
  containerRef?: string | null
): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/')) {
    return filePath;
  }
  if (!containerRef) return filePath;
  const usesWindows = containerRef.includes('\\');
  const sep = usesWindows ? '\\' : '/';
  const base = containerRef.replace(/[\\/]+$/, '');
  const normalized = usesWindows ? filePath.replaceAll('/', '\\') : filePath;
  return `${base}${sep}${normalized}`;
}

function processUnifiedDiff(unifiedDiff: string, hasLineNumbers: boolean) {
  const hideNums = !hasLineNumbers;
  let isValidDiff;
  let additions = 0;
  let deletions = 0;

  try {
    const parsed = parseInstance.parse(unifiedDiff);
    for (const hunk of parsed.hunks) {
      for (const line of hunk.lines) {
        if (line.type === DiffLineType.Add) additions++;
        else if (line.type === DiffLineType.Delete) deletions++;
      }
    }
    isValidDiff = parsed.hunks.length > 0;
  } catch (error) {
    console.error('Failed to parse diff hunks:', error);
    isValidDiff = false;
  }

  return {
    hunks: [unifiedDiff],
    hideLineNumbers: hideNums,
    additions,
    deletions,
    isValidDiff,
  };
}

function ProcessChangeFileRenderer({
  path,
  change,
  expansionKey,
  defaultExpanded = false,
  statusAppearance = 'default',
  forceExpanded = false,
  containerRef,
}: Props) {
  const { config } = useUserSystem();
  const { openDiffPreview } = usePanelActionsContext();
  const focusDiffPath = useGitDiffNavigationStore((state) => state.focusPath);
  const [expanded, setExpanded] = useExpandable(expansionKey, defaultExpanded);
  const effectiveExpanded = forceExpanded || expanded;

  const theme = getActualTheme(config?.theme);
  const resolvedPath = resolveFilePath(path, containerRef);
  const previewKind = getFilePreviewKind(path);
  const shouldRenderInlineTextDiff =
    isWrite(change) && effectiveExpanded && previewKind === 'text';

  const {
    data: headContent,
    isLoading: isLoadingHead,
    error: headError,
  } = useFileAtHead(shouldRenderInlineTextDiff ? resolvedPath : null);
  const editDiffState = useMemo(() => {
    if (!isEdit(change)) {
      return {
        hunks: [] as string[],
        hideLineNumbers: false,
        additions: 0,
        deletions: 0,
        isValidDiff: false,
      };
    }

    return processUnifiedDiff(change.unified_diff, change.has_line_numbers);
  }, [change]);
  const editDiffData = useMemo(() => {
    if (!isEdit(change)) return null;

    const lang = getHighLightLanguageFromPath(path) || 'plaintext';
    return {
      hunks: editDiffState.hunks,
      oldFile: { fileName: path, fileLang: lang },
      newFile: { fileName: path, fileLang: lang },
    };
  }, [change, editDiffState.hunks, path]);

  const statusIcon =
    statusAppearance === 'denied' ? (
      <FileX className="h-3.5 w-3.5 text-red-500" />
    ) : statusAppearance === 'timed_out' ? (
      <FileClock className="h-3.5 w-3.5 text-amber-500" />
    ) : null;

  const rowClassName = cn(
    'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
    'hover:bg-muted/40'
  );
  const handleOpenDiffFile = (
    event: MouseEvent<HTMLElement>,
    diffPath: string
  ) => {
    event.stopPropagation();
    openDiffPreview();
    focusDiffPath(diffPath);
  };

  if (statusIcon) {
    return (
      <div className={rowClassName}>
        {statusIcon}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {path}
        </span>
      </div>
    );
  }

  if (isEdit(change)) {
    return (
      <div>
        <div
          className={cn(rowClassName, 'cursor-pointer')}
          onClick={() => setExpanded()}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              effectiveExpanded && 'rotate-90'
            )}
          />
          <Edit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:text-primary hover:underline"
            onClick={(event) => handleOpenDiffFile(event, path)}
          >
            {path}
          </span>
          <span className="font-mono text-xs text-green-600 dark:text-green-400">
            +{editDiffState.additions}
          </span>
          <span className="font-mono text-xs text-red-600 dark:text-red-400">
            -{editDiffState.deletions}
          </span>
        </div>

        {effectiveExpanded && (
          <div
            className={cn(
              'mt-1 overflow-hidden rounded-md',
              editDiffState.hideLineNumbers && 'edit-diff-hide-nums'
            )}
            style={flatDiffSurfaceStyle}
          >
            {editDiffState.isValidDiff && editDiffData ? (
              <DiffView
                data={editDiffData}
                diffViewWrap={false}
                diffViewTheme={theme}
                diffViewHighlight
                diffViewMode={DiffModeEnum.Unified}
                diffViewFontSize={12}
              />
            ) : (
              <pre className="overflow-x-auto whitespace-pre-wrap px-2 py-2 font-mono text-xs text-muted-foreground">
                {change.unified_diff}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  const { titleText, icon, expandable, targetPath } = (() => {
    if (isDelete(change)) {
      return {
        titleText: path,
        icon: <Trash2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />,
        expandable: false,
        targetPath: path,
      };
    }

    if (isRename(change)) {
      return {
        titleText: `${path} -> ${change.new_path}`,
        icon: (
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ),
        expandable: false,
        targetPath: change.new_path,
      };
    }

    if (isWrite(change)) {
      return {
        titleText: path,
        icon: (
          <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ),
        expandable: true,
        targetPath: path,
      };
    }

    return { titleText: null, icon: null, expandable: false, targetPath: '' };
  })();

  if (!titleText) return null;

  const inlinePreviewMessage =
    previewKind === 'image'
      ? 'Image changes are not rendered inline. Open the preview panel to inspect this asset.'
      : previewKind === 'pdf'
        ? 'PDF changes are not rendered inline. Open the preview panel to inspect this asset.'
        : previewKind === 'document'
          ? 'Document changes are not rendered inline. Open the preview panel to inspect this asset.'
          : 'Binary changes are not rendered inline. Open the preview panel to inspect this asset.';

  return (
    <div>
      <div
        className={cn(rowClassName, expandable && 'cursor-pointer')}
        onClick={expandable ? () => setExpanded() : undefined}
      >
        {expandable && (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              effectiveExpanded && 'rotate-90'
            )}
          />
        )}
        {icon}
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:text-primary hover:underline"
          onClick={(event) => handleOpenDiffFile(event, targetPath)}
        >
          {titleText}
        </span>
      </div>

      {isWrite(change) && effectiveExpanded && (
        <div
          className="mt-1 overflow-hidden rounded-md"
          style={flatDiffSurfaceStyle}
        >
          {previewKind !== 'text' ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {inlinePreviewMessage}
            </div>
          ) : isLoadingHead ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              Loading diff...
            </div>
          ) : (
            <FileContentView
              content={change.content}
              originalContent={headError ? '' : (headContent ?? '')}
              lang={getHighLightLanguageFromPath(path)}
              theme={theme}
              diffMode="unified"
              emptyMessage="No differences against HEAD."
              className="plain-file-content bg-transparent"
            />
          )}
        </div>
      )}
    </div>
  );
}

export default ProcessChangeFileRenderer;
