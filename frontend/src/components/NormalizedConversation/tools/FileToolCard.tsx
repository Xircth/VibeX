import { useCallback } from 'react';
import { Check, Copy, Eye, FolderOpen } from 'lucide-react';
import type { NormalizedEntry } from 'shared/types';
import { Button } from '@/components/ui/button';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import { useExpandable } from '@/stores/useExpandableStore';
import { getToolSummary } from '../conversation-entry-utils';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
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
  const [copied, triggerCopied] = useTemporaryFlag(1500);
  const path = (actionType?.path || entry.content).trim();
  const summary = getToolSummary(toolEntry, entry.content.trim());
  const displayPath = summary.detail || path;
  const canOpenPreview = path.length > 0;

  const handleOpenPreview = useCallback(() => {
    if (!canOpenPreview) return;

    const resolvedPath = resolveToolFilePath(path, containerRef);
    const relativePath = deriveRelativeFilePath(resolvedPath, containerRef);
    const title = relativePath ?? displayPath;
    openFilePreview(resolvedPath, {
      displayPath: title,
      title,
    });
  }, [canOpenPreview, containerRef, displayPath, openFilePreview, path]);

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
          title="打开预览"
          aria-label="打开预览"
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
        title={copied ? '已复制' : '复制路径'}
        aria-label={copied ? '已复制' : '复制路径'}
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
      detail={displayPath}
      actions={actions}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      expanded={effectiveExpanded}
      expandable
      onToggle={toggle}
    >
      <div className="conv-tool-details-section-label">路径</div>
      <div className="conv-tool-details-content">{path}</div>
      {toolEntry.tool_name ? (
        <>
          <div className="conv-tool-details-section-label">工具</div>
          <div className="conv-tool-details-content">{toolEntry.tool_name}</div>
        </>
      ) : null}
    </ToolCardShell>
  );
}
