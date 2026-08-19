import { type FileChange } from 'shared/types';
import { useTranslation } from 'react-i18next';
import { useUserSystem } from '@/components/ConfigProvider';
import { getHighLightLanguageFromPath } from '@/utils/extToLanguage';
import { getActualTheme } from '@/utils/theme';
import { useFileAtHead } from '@/hooks/useFileContent';
import EditDiffRenderer from './EditDiffRenderer';
import FileContentView from './FileContentView';
import '@/styles/diff-style-overrides.css';
import { useExpandable } from '@/stores/useExpandableStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { getFilePreviewKind } from '@/utils/filePreviewKind';
import { ToolArtifact } from './tools/ToolArtifact';
import { useToolCallResultDetail } from './tools/ToolCardShell';

type Props = {
  path: string;
  change: FileChange;
  expansionKey: string;
  defaultExpanded?: boolean;
  statusAppearance?: 'default' | 'denied' | 'timed_out';
  forceExpanded?: boolean;
  containerRef?: string | null;
};

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

/** Build absolute path for file preview from a potentially relative path */
function resolveFilePath(
  filePath: string,
  containerRef?: string | null
): string {
  // Already absolute (Windows or Unix)
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

const FileChangeRenderer = ({
  path,
  change,
  expansionKey,
  defaultExpanded = false,
  statusAppearance = 'default',
  forceExpanded = false,
  containerRef,
}: Props) => {
  const { t } = useTranslation('conversation');
  const { config } = useUserSystem();
  const { openFilePreview } = usePanelActionsContext();
  const isResultDetail = useToolCallResultDetail();
  const [expanded, setExpanded] = useExpandable(expansionKey, defaultExpanded);
  const effectiveExpanded = forceExpanded || isResultDetail || expanded;

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

  if (statusAppearance === 'denied' || statusAppearance === 'timed_out') {
    return (
      <ToolArtifact
        badge={
          statusAppearance === 'denied'
            ? t('toolArtifact.denied')
            : t('toolArtifact.timedOut')
        }
        title={path}
        titleLabel={path}
      />
    );
  }

  // Edit: delegate to EditDiffRenderer for identical styling and behavior
  if (isEdit(change)) {
    return (
      <EditDiffRenderer
        path={path}
        unifiedDiff={change.unified_diff}
        hasLineNumbers={change.has_line_numbers}
        expansionKey={expansionKey}
        defaultExpanded={defaultExpanded}
        statusAppearance={statusAppearance}
        forceExpanded={forceExpanded}
        containerRef={containerRef}
      />
    );
  }

  const { badge, titleText, expandable, targetPath } = (() => {
    if (isDelete(change)) {
      return {
        badge: t('toolArtifact.delete'),
        titleText: path,
        expandable: false,
        targetPath: path,
      };
    }

    if (isRename(change)) {
      return {
        badge: t('toolArtifact.rename'),
        titleText: `${path} → ${change.new_path}`,
        expandable: false,
        targetPath: change.new_path,
      };
    }

    if (isWrite(change)) {
      return {
        badge: t('toolArtifact.write'),
        titleText: path,
        expandable: true,
        targetPath: path,
      };
    }

    return {
      badge: null,
      titleText: null,
      expandable: false,
      targetPath: '',
    };
  })();

  if (!titleText || !badge) return null;

  const inlinePreviewMessage = t('toolArtifact.openInPreview');

  return (
    <ToolArtifact
      badge={badge}
      title={titleText}
      titleLabel={titleText}
      onTitleClick={() => {
        const resolvedTargetPath = resolveFilePath(targetPath, containerRef);
        if (isWrite(change) && previewKind === 'text') {
          openFilePreview(resolvedTargetPath, {
            mode: 'diff',
            diffViewMode: 'inline',
            modifiedContent: change.content,
            displayPath: targetPath,
            title: targetPath,
          });
          return;
        }
        openFilePreview(resolvedTargetPath, {
          displayPath: targetPath,
          title: targetPath,
        });
      }}
      expandable={!isResultDetail && expandable}
      expanded={effectiveExpanded}
      onToggle={() => setExpanded()}
    >
      {isWrite(change) && effectiveExpanded ? (
        previewKind !== 'text' ? (
          <p className="conv-tool-prose">{inlinePreviewMessage}</p>
        ) : isLoadingHead ? (
          <p className="conv-tool-prose">{t('toolArtifact.loadingDiff')}</p>
        ) : (
          <FileContentView
            content={change.content}
            originalContent={headError ? '' : (headContent ?? '')}
            lang={getHighLightLanguageFromPath(path)}
            theme={theme}
            diffMode="unified"
            emptyMessage={t('toolArtifact.noHeadDiff')}
          />
        )
      ) : null}
    </ToolArtifact>
  );
};

export default FileChangeRenderer;
