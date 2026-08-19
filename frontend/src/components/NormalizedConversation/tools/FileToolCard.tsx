import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Eye, FolderOpen } from 'lucide-react';
import type { NormalizedEntry } from 'shared/types';
import { Button } from '@/components/ui/button';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import type { FileOpenLocation } from '@/components/file-tree/file-tree-types';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import { useExpandable } from '@/stores/useExpandableStore';
import { getToolSummary } from '../conversation-entry-utils';
import { ToolArtifact, ToolCodeSnippet } from './ToolArtifact';
import { ToolCallTarget } from './ToolCallTarget';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
  useToolCallResultDetail,
} from './ToolCardShell';

export function resolveToolFilePath(
  path: string,
  containerRef?: string | null
) {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/')) {
    return path;
  }

  if (!containerRef) return path;

  const usesWindows = containerRef.includes('\\');
  const separator = usesWindows ? '\\' : '/';
  const base = containerRef.replace(/[\\/]+$/, '');
  const normalized = usesWindows ? path.replaceAll('/', '\\') : path;
  return `${base}${separator}${normalized}`;
}

export function fileReadLocation(
  lineStart?: number | null,
  lineEnd?: number | null
): FileOpenLocation | null {
  if (lineStart == null) return null;
  return {
    line: lineStart,
    column: 1,
    ...(lineEnd != null ? { endLine: lineEnd } : {}),
  };
}

export function FileToolCard({
  entry,
  expansionKey,
  forceExpanded = false,
  containerRef,
}: {
  entry: NormalizedEntry;
  expansionKey: string;
  forceExpanded?: boolean;
  containerRef?: string | null;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : undefined;
  const actionType =
    toolEntry?.action_type.action === 'file_read'
      ? toolEntry.action_type
      : null;
  const [expanded, toggle] = useExpandable(
    `file-tool-entry:${expansionKey}`,
    false
  );
  const effectiveExpanded = forceExpanded || expanded;
  const { openFilePreview } = usePanelActionsContext();
  const isResultDetail = useToolCallResultDetail();
  const [copied, triggerCopied] = useTemporaryFlag(1500);
  const path = (actionType?.path || entry.content).trim();
  const summary = getToolSummary(toolEntry, entry.content.trim());
  const displayPath = summary.detail || path;
  const canOpenPreview = path.length > 0;
  const lineRange =
    actionType?.line_start != null
      ? actionType.line_end != null
        ? t('messageTurnView.fileReadRange', {
            start: actionType.line_start,
            end: actionType.line_end,
          })
        : t('messageTurnView.fileReadFrom', { start: actionType.line_start })
      : null;

  const handleOpenPreview = useCallback(() => {
    if (!canOpenPreview) return;

    const resolvedPath = resolveToolFilePath(path, containerRef);
    const relativePath = deriveRelativeFilePath(resolvedPath, containerRef);
    const title = relativePath ?? displayPath;
    openFilePreview(resolvedPath, {
      displayPath: title,
      title,
      location: fileReadLocation(actionType?.line_start, actionType?.line_end),
    });
  }, [
    actionType?.line_end,
    actionType?.line_start,
    canOpenPreview,
    containerRef,
    displayPath,
    openFilePreview,
    path,
  ]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path || entry.content);
      triggerCopied();
    } catch {
      // Clipboard writes can be blocked outside a secure browser context.
    }
  }, [entry.content, path, triggerCopied]);

  if (!toolEntry || !actionType) return null;

  const actions = (
    <>
      {canOpenPreview ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0"
          title={t('fileTool.openPreview')}
          aria-label={t('fileTool.openPreview')}
          onClick={handleOpenPreview}
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 w-5 p-0"
        title={copied ? t('fileTool.copied') : t('fileTool.copyPath')}
        aria-label={copied ? t('fileTool.copied') : t('fileTool.copyPath')}
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </>
  );

  return (
    <ToolCardShell
      icon={<Eye className="h-3 w-3" />}
      label={summary.label}
      detail={
        <ToolCallTarget
          text={displayPath}
          path={path}
          onClick={canOpenPreview ? handleOpenPreview : undefined}
        />
      }
      actions={isResultDetail ? undefined : actions}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded={effectiveExpanded}
      expandable
      onToggle={toggle}
    >
      <ToolArtifact
        badge={isResultDetail ? t('toolArtifact.view') : undefined}
        title={isResultDetail ? undefined : displayPath}
        titleLabel={displayPath}
        onTitleClick={
          !isResultDetail && canOpenPreview ? handleOpenPreview : undefined
        }
        meta={lineRange}
        actions={isResultDetail ? actions : undefined}
      >
        {actionType.content ? (
          <ToolCodeSnippet
            path={path}
            content={actionType.content}
            startLine={actionType.line_start ?? 1}
          />
        ) : null}
      </ToolArtifact>
    </ToolCardShell>
  );
}
