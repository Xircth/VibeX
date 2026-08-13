import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ExternalLink, Globe, Search } from 'lucide-react';
import type { NormalizedEntry, ToolResult } from 'shared/types';
import { Button } from '@/components/ui/button';
import { useOpenLink } from '@/hooks/useOpenLink';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { useExpandable } from '@/stores/useExpandableStore';
import { getToolSummary, renderJson } from '../conversation-entry-utils';
import { ToolResultView } from './ToolResultView';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

type SearchResultItem = {
  path: string | null;
  line: string | null;
  text: string;
};

function stringSearchResults(value: string): SearchResultItem[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.*):(\d+):\s?(.*)$/);
      return match
        ? { path: match[1], line: match[2], text: match[3] }
        : { path: null, line: null, text: line };
    });
}

function searchResultItems(
  result: ToolResult | null | undefined
): SearchResultItem[] {
  if (!result || typeof result !== 'object' || !('value' in result)) return [];
  const value = (result as { value: unknown }).value;
  if (typeof value === 'string') return stringSearchResults(value);
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (typeof item === 'string') return stringSearchResults(item);
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const path = [record.path, record.file, record.file_path].find(
      (field): field is string => typeof field === 'string'
    );
    const line = [record.line, record.line_number].find(
      (field) => typeof field === 'string' || typeof field === 'number'
    );
    const text = [
      record.text,
      record.content,
      record.match,
      record.preview,
    ].find((field): field is string => typeof field === 'string');
    return text || path
      ? [
          {
            path: path ?? null,
            line: line != null ? String(line) : null,
            text: text ?? '',
          },
        ]
      : [];
  });
}

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
  const detail =
    actionType?.action === 'search'
      ? actionType.query.trim()
      : (actionType?.url || entry.content).trim();
  const summary = getToolSummary(toolEntry, entry.content.trim());
  const canOpenLink = isWebFetch && /^https?:\/\//i.test(detail);
  const [copied, triggerCopied] = useTemporaryFlag(1500);
  const openLink = useOpenLink();
  const resultItems =
    actionType?.action === 'search' ? searchResultItems(actionType.result) : [];

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
      actions={actions}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded={effectiveExpanded}
      expandable
      onToggle={toggle}
    >
      <div className="conv-tool-details-section-label">
        {isWebFetch ? 'URL' : t('searchTool.query')}
      </div>
      <div className="conv-tool-details-content">{detail}</div>
      {actionType.action === 'search' && actionType.arguments ? (
        <>
          <div className="conv-tool-details-section-label">
            {t('genericTool.arguments')}
          </div>
          <div className="conv-tool-details-content">
            {renderJson(actionType.arguments)}
          </div>
        </>
      ) : null}
      {actionType.action === 'search' && actionType.result ? (
        <>
          <div className="conv-tool-details-section-label">
            {t('genericTool.result')}
          </div>
          <div className="conv-tool-details-content">
            {resultItems.length > 0 ? (
              <ul
                className="conv-tool-search-results"
                aria-label={t('messageTurnView.searchResults')}
              >
                {resultItems.map((item, index) => (
                  <li
                    key={`${item.path ?? 'result'}-${item.line ?? index}-${index}`}
                  >
                    {item.path ? (
                      <span className="conv-tool-search-result-path">
                        <span>{item.path}</span>
                        {item.line ? <span>:{item.line}</span> : null}
                      </span>
                    ) : null}
                    {item.text ? <span>{item.text}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <ToolResultView result={actionType.result} />
            )}
          </div>
        </>
      ) : null}
    </ToolCardShell>
  );
}
