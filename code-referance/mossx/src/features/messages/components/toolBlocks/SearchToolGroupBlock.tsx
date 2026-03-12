/**
 * 批量搜索分组组件
 * Groups multiple consecutive Search/Grep/Glob tool calls
 */
import { memo, useMemo, useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { ConversationItem } from '../../../../types';
import {
  parseToolArgs,
  getFirstStringField,
  truncateText,
  resolveToolStatus,
  extractToolName,
  type ToolStatusTone,
} from './toolConstants';

type ToolItem = Extract<ConversationItem, { kind: 'tool' }>;

interface SearchToolGroupBlockProps {
  items: ToolItem[];
}

interface ParsedSearchItem {
  id: string;
  pattern: string;
  summary: string;
  status: ToolStatusTone;
}

const MAX_VISIBLE_ITEMS = 6;
const ITEM_HEIGHT = 30;
const URL_GLOBAL_REGEX = /(https?:\/\/[^\s"'<>]+)/g;
const QUERY_KEYS = ['query', 'q', 'searchQuery', 'search_query', 'text', 'pattern'];

function extractQueryLikeText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractQueryLikeText(entry);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of QUERY_KEYS) {
      if (key in record) {
        const found = extractQueryLikeText(record[key]);
        if (found) return found;
      }
    }
  }

  return null;
}

function normalizeSummaryText(raw: string, args: unknown): string {
  const trimmedRaw = raw.trim();
  if (trimmedRaw) {
    try {
      const parsed = JSON.parse(trimmedRaw);
      const fromParsed = extractQueryLikeText(parsed);
      if (fromParsed) return fromParsed;
    } catch {
      // raw 不是 JSON，继续按普通文本处理
    }

    // 非 JSON/解析失败时，优先保留原始输出文本，避免被 query 覆盖
    if (!(trimmedRaw.startsWith('{') || trimmedRaw.startsWith('['))) {
      return trimmedRaw;
    }
  }

  const fromArgs = extractQueryLikeText(args);
  if (fromArgs) return fromArgs;

  return trimmedRaw;
}

function renderTextWithLinks(text: string): Array<{ type: 'text' | 'link'; value: string; href?: string }> {
  const parts: Array<{ type: 'text' | 'link'; value: string; href?: string }> = [];
  let lastIndex = 0;
  const matches = Array.from(text.matchAll(URL_GLOBAL_REGEX));

  for (const match of matches) {
    const url = match[1]?.replace(/[),.;!?]+$/, '');
    const index = match.index ?? -1;
    if (!url || index < 0) continue;
    if (index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, index) });
    }
    parts.push({ type: 'link', value: match[1], href: url });
    lastIndex = index + match[1].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: text }];
}

function parseSearchItem(item: ToolItem): ParsedSearchItem {
  const args = parseToolArgs(item.detail);
  const pattern = getFirstStringField(args, ['pattern', 'query', 'q', 'search_term', 'searchQuery', 'text']);
  const path = getFirstStringField(args, ['path', 'directory', 'dir']);
  const status = resolveToolStatus(item.status, Boolean(item.output));
  const detail = item.detail?.trim() ?? '';
  const output = item.output?.trim() ?? '';
  const summaryRaw = output || detail || path;
  const normalizedSummary = normalizeSummaryText(summaryRaw, args);
  const summary = truncateText(normalizedSummary.replace(/\s+/g, ' ').trim(), 90);

  return {
    id: item.id,
    pattern: truncateText(pattern, 50),
    summary,
    status,
  };
}

function groupStatus(items: ToolItem[]): ToolStatusTone {
  const hasProcessing = items.some(
    (item) => resolveToolStatus(item.status, Boolean(item.output)) === 'processing',
  );
  if (hasProcessing) return 'processing';
  const hasFailed = items.some(
    (item) => resolveToolStatus(item.status, Boolean(item.output)) === 'failed',
  );
  if (hasFailed) return 'failed';
  return 'completed';
}

export const SearchToolGroupBlock = memo(function SearchToolGroupBlock({
  items,
}: SearchToolGroupBlockProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevCountRef = useRef(items.length);

  const parsed = useMemo(() => items.map(parseSearchItem), [items]);
  const status = groupStatus(items);

  useEffect(() => {
    if (items.length > prevCountRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevCountRef.current = items.length;
  }, [items.length]);

  const listHeight = Math.min(parsed.length, MAX_VISIBLE_ITEMS) * ITEM_HEIGHT;
  const needsScroll = parsed.length > MAX_VISIBLE_ITEMS;

  // 检查是否有 glob 类型
  const hasGlob = items.some((item) => {
    const name = extractToolName(item.title).toLowerCase();
    return name.includes('glob') || name.includes('find');
  });

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setIsExpanded((prev) => !prev)}
        style={{
          borderBottom: isExpanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div
          className="task-title-section search-title-minimal"
          aria-label={hasGlob ? t("tools.batchSearchMatch") : t("tools.batchSearch")}
        >
          <span className="codicon codicon-search tool-title-icon" />
          <span className="tool-title-summary search-group-count">
            ({items.length})
          </span>
        </div>
        <div className={`tool-status-indicator ${status === 'failed' ? 'error' : status === 'completed' ? 'completed' : 'pending'}`} />
      </div>

      {isExpanded && (
        <div
          className="task-details file-list-container"
          ref={listRef}
          style={{
            padding: '4px 8px',
            border: 'none',
            maxHeight: needsScroll ? `${listHeight + 12}px` : undefined,
            overflowY: needsScroll ? 'auto' : 'hidden',
            overflowX: 'hidden',
          }}
        >
          {parsed.map((entry) => (
            <div
              key={entry.id}
              className="file-list-item search-list-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: '4px',
                minHeight: `${ITEM_HEIGHT}px`,
              }}
            >
              <span className="search-item-pattern">{entry.pattern || '...'}</span>
              {entry.summary && (
                <span className="search-item-inline-output" title={entry.summary}>
                  {renderTextWithLinks(entry.summary).map((segment, idx) => (
                    segment.type === 'link' && segment.href ? (
                      <a
                        key={`${segment.href}-${idx}`}
                        className="search-inline-link"
                        href={segment.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={(event) => {
                          event.preventDefault();
                          void openUrl(segment.href!);
                        }}
                      >
                        {segment.value}
                      </a>
                    ) : (
                      <span key={`${segment.value}-${idx}`}>{segment.value}</span>
                    )
                  ))}
                </span>
              )}
              <div
                className={`tool-status-indicator ${entry.status === 'failed' ? 'error' : entry.status === 'completed' ? 'completed' : 'pending'}`}
                style={{ marginLeft: '8px', marginRight: 0 }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export default SearchToolGroupBlock;
