import { type FileChange } from 'shared/types';
import { useUserSystem } from '@/components/ConfigProvider';
import {
  Trash2,
  FilePlus2,
  ArrowRight,
  FileX,
  FileClock,
  ChevronRight,
} from 'lucide-react';
import { getHighLightLanguageFromPath } from '@/utils/extToLanguage';
import { getActualTheme } from '@/utils/theme';
import { useFileAtHead } from '@/hooks/useFileContent';
import EditDiffRenderer from './EditDiffRenderer';
import FileContentView from './FileContentView';
import '@/styles/diff-style-overrides.css';
import { useExpandable } from '@/stores/useExpandableStore';
import { cn } from '@/lib/utils';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { getFilePreviewKind } from '@/utils/filePreviewKind';

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
  const { config } = useUserSystem();
  const { openFilePreview } = usePanelActionsContext();
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

  const statusIcon =
    statusAppearance === 'denied' ? (
      <FileX className="h-3 w-3" />
    ) : statusAppearance === 'timed_out' ? (
      <FileClock className="h-3 w-3" />
    ) : null;

  if (statusIcon) {
    return (
      <div
        className={cn(
          'conv-file-card conv-tool-card',
          statusAppearance === 'denied' && 'border-red-400/40',
          statusAppearance === 'timed_out' && 'border-amber-400/40'
        )}
      >
        {statusIcon}
        <span className="conv-file-name">{path}</span>
      </div>
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

  // Determine icon and expandability by change type
  const { titleText, icon, expandable, targetPath } = (() => {
    if (isDelete(change)) {
      return {
        titleText: path,
        icon: <Trash2 className="h-3 w-3 conv-file-icon" />,
        expandable: false,
        targetPath: path,
      };
    }

    if (isRename(change)) {
      return {
        titleText: `${path} → ${change.new_path}`,
        icon: <ArrowRight className="h-3 w-3 conv-file-icon" />,
        expandable: false,
        targetPath: change.new_path,
      };
    }

    if (isWrite(change)) {
      return {
        titleText: path,
        icon: <FilePlus2 className="h-3 w-3 conv-file-icon" />,
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
        : 'Binary changes are not rendered inline. Open the preview panel to inspect this asset.';

  return (
    <div>
      <div
        className="conv-file-card conv-tool-card"
        onClick={expandable ? () => setExpanded() : undefined}
      >
        {expandable && (
          <ChevronRight
            className={cn(
              'h-3 w-3 conv-file-chevron',
              effectiveExpanded && 'is-expanded'
            )}
          />
        )}
        {icon}
        <span
          className="conv-file-name"
          onClick={(e) => {
            e.stopPropagation();
            const resolvedTargetPath = resolveFilePath(
              targetPath,
              containerRef
            );
            const displayPath = targetPath;
            if (isWrite(change) && previewKind === 'text') {
              openFilePreview(resolvedTargetPath, {
                mode: 'diff',
                diffViewMode: 'inline',
                modifiedContent: change.content,
                displayPath,
                title: displayPath,
              });
              return;
            }
            openFilePreview(resolvedTargetPath, {
              displayPath,
              title: displayPath,
            });
          }}
        >
          {titleText}
        </span>
      </div>

      {/* Body */}
      {isWrite(change) && effectiveExpanded && (
        <div className="mt-1 overflow-hidden rounded-b-lg border border-t-0 border-[var(--conv-border-subtle)] bg-[var(--conv-surface-card)]">
          {previewKind !== 'text' ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              {inlinePreviewMessage}
            </div>
          ) : isLoadingHead ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">
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
            />
          )}
        </div>
      )}
    </div>
  );
};

export default FileChangeRenderer;
