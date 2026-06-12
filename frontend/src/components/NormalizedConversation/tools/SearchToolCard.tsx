import { useCallback } from 'react';
import { Check, Copy, ExternalLink, Globe, Search } from 'lucide-react';
import type { NormalizedEntry } from 'shared/types';
import { Button } from '@/components/ui/button';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { useExpandable } from '@/stores/useExpandableStore';
import { getToolSummary } from '../conversation-entry-utils';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
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
  const detail =
    actionType?.action === 'search'
      ? actionType.query.trim()
      : (actionType?.url || entry.content).trim();
  const summary = getToolSummary(toolEntry, entry.content.trim());
  const canOpenLink = isWebFetch && /^https?:\/\//i.test(detail);
  const [copied, triggerCopied] = useTemporaryFlag(1500);

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
    window.open(detail, '_blank', 'noopener,noreferrer');
  }, [canOpenLink, detail]);

  if (!toolEntry || !actionType) return null;

  const actions = (
    <>
      {canOpenLink ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0"
          title="打开链接"
          aria-label="打开链接"
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
        title={copied ? '已复制' : isWebFetch ? '复制 URL' : '复制查询'}
        aria-label={copied ? '已复制' : isWebFetch ? '复制 URL' : '复制查询'}
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-600" />
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
      actions={actions}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      expanded={effectiveExpanded}
      expandable
      onToggle={toggle}
    >
      <div className="conv-tool-details-section-label">
        {isWebFetch ? 'URL' : '查询'}
      </div>
      <div className="conv-tool-details-content">{detail}</div>
      {toolEntry.tool_name ? (
        <>
          <div className="conv-tool-details-section-label">工具</div>
          <div className="conv-tool-details-content">{toolEntry.tool_name}</div>
        </>
      ) : null}
    </ToolCardShell>
  );
}
