import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ExternalLink, Globe, Search } from 'lucide-react';
import type { NormalizedEntry } from 'shared/types';
import { Button } from '@/components/ui/button';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { useOpenLink } from '@/hooks/useOpenLink';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { useExpandable } from '@/stores/useExpandableStore';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import { getToolSummary } from '../conversation-entry-utils';
import { ToolArtifact, ToolSearchHits } from './ToolArtifact';
import { fileReadLocation, resolveToolFilePath } from './FileToolCard';
import { parseSearchQuery, parseToolHitItems } from './toolHitItems';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
  useToolCallResultDetail,
} from './ToolCardShell';

export function SearchToolCard({
  entry,
  expansionKey,
  forceExpanded = false,
}: {
  entry: NormalizedEntry;
  expansionKey: string;
  forceExpanded?: boolean;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : undefined;
  const actionType =
    toolEntry?.action_type.action === 'search' ||
    toolEntry?.action_type.action === 'web_fetch'
      ? toolEntry.action_type
      : null;
  const [expanded, toggle] = useExpandable(
    `search-tool-entry:${expansionKey}`,
    false
  );
  const effectiveExpanded = forceExpanded || expanded;
  const isWebFetch = actionType?.action === 'web_fetch';
  const searchQuery =
    actionType?.action === 'search'
      ? actionType.query.trim() ||
        parseSearchQuery(actionType.arguments) ||
        parseSearchQuery(actionType.result?.value) ||
        ''
      : '';
  const detail = isWebFetch
    ? (actionType?.url || entry.content).trim()
    : searchQuery;
  const summary = getToolSummary(toolEntry, entry.content.trim());
  const canOpenLink = isWebFetch && /^https?:\/\//i.test(detail);
  const isResultDetail = useToolCallResultDetail();
  const [copied, triggerCopied] = useTemporaryFlag(1500);
  const openLink = useOpenLink();
  const panelActions = useOptionalPanelActionsContext();
  const resultItems =
    actionType?.action === 'search'
      ? parseToolHitItems(actionType.result?.value ?? actionType.result)
      : [];

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(detail || entry.content);
      triggerCopied();
    } catch {
      // Clipboard writes can be blocked outside a secure browser context.
    }
  }, [detail, entry.content, triggerCopied]);

  const handleOpenLink = useCallback(() => {
    if (!canOpenLink) return;
    openLink(detail);
  }, [canOpenLink, detail, openLink]);

  if (!toolEntry || !actionType) return null;

  const actions = (
    <>
      {canOpenLink ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0"
          title={t('searchTool.openLink')}
          aria-label={t('searchTool.openLink')}
          onClick={handleOpenLink}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 w-5 p-0"
        title={
          copied
            ? t('searchTool.copied')
            : isWebFetch
              ? t('searchTool.copyUrl')
              : t('searchTool.copyQuery')
        }
        aria-label={
          copied
            ? t('searchTool.copied')
            : isWebFetch
              ? t('searchTool.copyUrl')
              : t('searchTool.copyQuery')
        }
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
      icon={
        isWebFetch ? (
          <Globe className="h-3 w-3" />
        ) : (
          <Search className="h-3 w-3" />
        )
      }
      label={summary.label}
      detail={detail}
      actions={isResultDetail ? undefined : actions}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded={effectiveExpanded}
      expandable
      onToggle={toggle}
    >
      {isWebFetch ? (
        <ToolArtifact
          badge={t('toolArtifact.fetch')}
          title={detail}
          titleLabel={detail}
          onTitleClick={canOpenLink ? handleOpenLink : undefined}
          actions={isResultDetail ? actions : undefined}
        />
      ) : (
        <ToolSearchHits
          items={resultItems}
          onOpenUrl={openLink}
          onOpenPath={(path, line) => {
            const resolved = resolveToolFilePath(path);
            const title = deriveRelativeFilePath(resolved) ?? path;
            panelActions?.openFilePreview(resolved, {
              displayPath: title,
              title,
              location: fileReadLocation(line, line),
            });
          }}
          onOpenDirectory={(path) => {
            panelActions?.revealInFileTree(path, { nodeType: 'folder' });
          }}
        />
      )}
    </ToolCardShell>
  );
}
