import { useMemo } from 'react';
import { DiffView, DiffModeEnum, parseInstance } from '@git-diff-view/react';
import { ChevronRight, Edit } from 'lucide-react';
import { useUserSystem } from '@/components/ConfigProvider';
import { getHighLightLanguageFromPath } from '@/utils/extToLanguage';
import { getActualTheme } from '@/utils/theme';
import { parseDiffStats } from '@/utils/diffStatsParser';
/* diff-style-overrides.css and edit-diff-overrides.css imported by parent FileChangeRenderer */
import { cn } from '@/lib/utils';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';

type Props = {
  path: string;
  unifiedDiff: string;
  hasLineNumbers: boolean;
  expansionKey: string;
  defaultExpanded?: boolean;
  statusAppearance?: 'default' | 'denied' | 'timed_out';
  forceExpanded?: boolean;
  containerRef?: string | null;
};

/**
 * Process hunks for @git-diff-view/react
 * - Extract additions/deletions for display
 * - Decide whether to hide line numbers based on backend data
 */
function processUnifiedDiff(unifiedDiff: string, hasLineNumbers: boolean) {
  // Hide line numbers when backend says they are unreliable
  const hideNums = !hasLineNumbers;
  let isValidDiff;
  const { additions, deletions } = parseDiffStats(unifiedDiff);

  try {
    const parsed = parseInstance.parse(unifiedDiff);
    isValidDiff = parsed.hunks.length > 0;
  } catch (err) {
    console.error('Failed to parse diff hunks:', err);
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

import { useExpandable } from '@/stores/useExpandableStore';

/** Build absolute path for file preview from a potentially relative path */
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

function EditDiffRenderer({
  path,
  unifiedDiff,
  hasLineNumbers,
  expansionKey,
  defaultExpanded = false,
  statusAppearance = 'default',
  forceExpanded = false,
  containerRef,
}: Props) {
  const { config } = useUserSystem();
  const { openFilePreview } = usePanelActionsContext();
  const [expanded, setExpanded] = useExpandable(expansionKey, defaultExpanded);
  const effectiveExpanded = forceExpanded || expanded;

  const theme = getActualTheme(config?.theme);
  const { hunks, hideLineNumbers, additions, deletions, isValidDiff } = useMemo(
    () => processUnifiedDiff(unifiedDiff, hasLineNumbers),
    [unifiedDiff, hasLineNumbers]
  );

  const hideLineNumbersClass = hideLineNumbers ? ' edit-diff-hide-nums' : '';
  const hasDiff = unifiedDiff.trim().length > 0;

  const diffData = useMemo(() => {
    const lang = getHighLightLanguageFromPath(path) || 'plaintext';
    return {
      hunks,
      oldFile: { fileName: path, fileLang: lang },
      newFile: { fileName: path, fileLang: lang },
    };
  }, [hunks, path]);

  return (
    <div>
      <div
        className={cn(
          'conv-file-card conv-tool-card',
          statusAppearance === 'denied' && 'border-red-400/40',
          statusAppearance === 'timed_out' && 'border-amber-400/40'
        )}
        onClick={() => setExpanded()}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 conv-file-chevron',
            effectiveExpanded && 'is-expanded'
          )}
        />
        <Edit className="h-3 w-3 conv-file-icon" />
        <span className="conv-tool-label shrink-0">Edit</span>
        <button
          type="button"
          className="conv-file-name border-0 bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          aria-label={`Open ${path}`}
          onClick={(e) => {
            e.stopPropagation();
            openFilePreview(
              resolveFilePath(path, containerRef),
              hasDiff
                ? {
                    mode: 'diff',
                    diffViewMode: 'inline',
                    displayPath: path,
                    title: path,
                  }
                : { displayPath: path, title: path }
            );
          }}
        >
          {path}
        </button>
        {hasDiff ? (
          <>
            <span className="conv-file-stat-add">+{additions}</span>
            <span className="conv-file-stat-del">-{deletions}</span>
          </>
        ) : null}
      </div>

      {effectiveExpanded && hasDiff && (
        <div
          className={cn(
            'mt-1 overflow-hidden rounded-b-lg border border-t-0',
            'border-[var(--conv-border-subtle)]',
            hideLineNumbersClass
          )}
        >
          {isValidDiff ? (
            <DiffView
              data={diffData}
              diffViewWrap={false}
              diffViewTheme={theme}
              diffViewHighlight
              diffViewMode={DiffModeEnum.Unified}
              diffViewFontSize={12}
            />
          ) : (
            <pre
              className="px-4 pb-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap"
              style={{ color: 'var(--conv-text-secondary)' }}
            >
              {unifiedDiff}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default EditDiffRenderer;
