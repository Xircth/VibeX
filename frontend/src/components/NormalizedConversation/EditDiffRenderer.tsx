import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DiffView, DiffModeEnum, parseInstance } from '@git-diff-view/react';
import { useUserSystem } from '@/components/ConfigProvider';
import { getHighLightLanguageFromPath } from '@/utils/extToLanguage';
import { getActualTheme } from '@/utils/theme';
import { parseDiffStats } from '@/utils/diffStatsParser';
import { useExpandable } from '@/stores/useExpandableStore';
import '@/styles/diff-style-overrides.css';
import '@/styles/edit-diff-overrides.css';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { ToolArtifact } from './tools/ToolArtifact';
import { useToolCallResultDetail } from './tools/ToolCardShell';

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
  const { t } = useTranslation('conversation');
  const { config } = useUserSystem();
  const { openFilePreview } = usePanelActionsContext();
  const isResultDetail = useToolCallResultDetail();
  const [expanded, setExpanded] = useExpandable(expansionKey, defaultExpanded);
  const effectiveExpanded = forceExpanded || isResultDetail || expanded;

  const theme = getActualTheme(config?.theme);
  const { hunks, hideLineNumbers, additions, deletions, isValidDiff } = useMemo(
    () => processUnifiedDiff(unifiedDiff, hasLineNumbers),
    [unifiedDiff, hasLineNumbers]
  );

  const hasDiff = unifiedDiff.trim().length > 0;

  const diffData = useMemo(() => {
    const lang = getHighLightLanguageFromPath(path) || 'plaintext';
    return {
      hunks,
      oldFile: { fileName: path, fileLang: lang },
      newFile: { fileName: path, fileLang: lang },
    };
  }, [hunks, path]);

  const badge =
    statusAppearance === 'denied'
      ? t('toolArtifact.denied')
      : statusAppearance === 'timed_out'
        ? t('toolArtifact.timedOut')
        : t('toolArtifact.edit');

  return (
    <ToolArtifact
      badge={isResultDetail ? undefined : badge}
      title={isResultDetail ? undefined : path}
      titleLabel={path}
      onTitleClick={
        isResultDetail
          ? undefined
          : () =>
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
              )
      }
      additions={isResultDetail || !hasDiff ? undefined : additions}
      deletions={isResultDetail || !hasDiff ? undefined : deletions}
      expandable={!isResultDetail && hasDiff}
      expanded={effectiveExpanded}
      onToggle={() => setExpanded()}
    >
      {hasDiff ? (
        isValidDiff ? (
          <div className={hideLineNumbers ? 'edit-diff-hide-nums' : undefined}>
            <DiffView
              data={diffData}
              diffViewWrap={false}
              diffViewTheme={theme}
              diffViewHighlight
              diffViewMode={DiffModeEnum.Unified}
              diffViewFontSize={12}
            />
          </div>
        ) : (
          <pre className="conv-tool-diff-fallback">{unifiedDiff}</pre>
        )
      ) : null}
    </ToolArtifact>
  );
}

export default EditDiffRenderer;
