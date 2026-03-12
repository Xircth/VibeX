/**
 * 搜索工具块组件 - 用于展示 Grep、Glob 等搜索操作
 * Search Tool Block Component - for displaying grep, glob and other search operations
 * 使用 task-container 样式 + codicon 图标（匹配参考项目）
 */
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { ConversationItem } from '../../../../types';
import {
  parseToolArgs,
  getFirstStringField,
  truncateText,
  extractToolName,
  resolveToolStatus,
} from './toolConstants';

interface SearchToolBlockProps {
  item: Extract<ConversationItem, { kind: 'tool' }>;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}

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

/**
 * 获取状态
 */
function getStatus(item: Extract<ConversationItem, { kind: 'tool' }>): 'completed' | 'processing' | 'failed' {
  return resolveToolStatus(item.status, Boolean(item.output));
}

export const SearchToolBlock = memo(function SearchToolBlock({
  item,
  isExpanded: _isExpanded,
  onToggle: _onToggle,
}: SearchToolBlockProps) {
  const { t } = useTranslation();
  const toolName = extractToolName(item.title);
  const isGlob = toolName.toLowerCase().includes('glob') || toolName.toLowerCase().includes('find');

  const args = useMemo(() => parseToolArgs(item.detail), [item.detail]);

  const pattern = getFirstStringField(args, ['pattern', 'query', 'q', 'search_term', 'searchQuery', 'text']);
  const displayPattern = truncateText(pattern, 60);
  const path = getFirstStringField(args, ['path', 'directory', 'dir']);
  const fallbackDetail = item.detail?.trim() ?? '';
  const inlineRaw = item.output || fallbackDetail || path || '';
  const normalizedInline = normalizeSummaryText(inlineRaw, args);
  const inlineSummary = truncateText(
    normalizedInline.replace(/\s+/g, ' ').trim(),
    120,
  );
  const inlineSegments = renderTextWithLinks(inlineSummary);

  const status = getStatus(item);
  const codiconClass = isGlob ? 'codicon-folder' : 'codicon-search';
  const displayName = isGlob ? t("tools.fileMatch") : t("tools.search");
  const isError = status === 'failed';
  const isCompleted = status === 'completed';

  return (
    <div className="task-container search-task-container">
      <div className="task-header search-task-header">
        <div className="task-title-section search-title-minimal" aria-label={displayName}>
          <span className={`codicon ${codiconClass} tool-title-icon`} />
          {displayPattern && !inlineSummary && (
            <span className="tool-title-summary" title={pattern}>
              {displayPattern}
            </span>
          )}
          {inlineSummary && (
            <span className="tool-title-summary search-inline-summary" title={normalizedInline}>
              {inlineSegments.map((segment, idx) => (
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
        </div>
        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>
    </div>
  );
});

export default SearchToolBlock;
