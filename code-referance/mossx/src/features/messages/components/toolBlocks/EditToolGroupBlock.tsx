/**
 * 批量编辑文件分组组件
 * 参考 idea-claude-code-gui 的渲染细节，展示连续编辑工具的文件列表与 diff 统计
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationItem } from '../../../../types';
import {
  getFileName,
  parseToolArgs,
  resolveToolStatus,
  type ToolStatusTone,
  asRecord,
  pickStringField,
  EDIT_PATH_KEYS,
  EDIT_OLD_KEYS,
  EDIT_NEW_KEYS,
  EDIT_CONTENT_KEYS,
} from './toolConstants';
import { computeDiffStats, computeDiffFromUnifiedPatch, type DiffStats } from '../../utils/diffUtils';
import { FileIcon } from './FileIcon';

type ToolItem = Extract<ConversationItem, { kind: 'tool' }>;

interface EditToolGroupBlockProps {
  items: ToolItem[];
  onOpenDiffPath?: (path: string) => void;
}

interface ParsedEditItem {
  id: string;
  fileName: string;
  filePath: string;
  diff: DiffStats;
  status: ToolStatusTone;
}

const MAX_VISIBLE_ITEMS = 3;
const ITEM_HEIGHT = 32;

function parseEditItem(item: ToolItem): ParsedEditItem | null {
  const args = parseToolArgs(item.detail);
  const nestedInput = asRecord(args?.input);
  const nestedArgs = asRecord(args?.arguments);
  let filePath = '';
  let diff: DiffStats;
  if (item.toolType === 'fileChange' && item.changes?.length) {
    filePath = item.changes[0]?.path ?? '';
    diff = item.changes.reduce(
      (acc, change) => {
        const stats = computeDiffFromUnifiedPatch(change.diff ?? '');
        return { additions: acc.additions + stats.additions, deletions: acc.deletions + stats.deletions };
      },
      { additions: 0, deletions: 0 },
    );
  } else {
    filePath = pickStringField(args, nestedInput, nestedArgs, EDIT_PATH_KEYS);
    const oldString = pickStringField(args, nestedInput, nestedArgs, EDIT_OLD_KEYS);
    const newString = pickStringField(args, nestedInput, nestedArgs, EDIT_NEW_KEYS);
    if (oldString || newString) {
      diff = computeDiffStats(oldString, newString);
    } else {
      const content = pickStringField(args, nestedInput, nestedArgs, EDIT_CONTENT_KEYS);
      if (content) {
        diff = { additions: content.split('\n').length, deletions: 0 };
      } else {
        diff = { additions: 0, deletions: 0 };
      }
    }
  }

  if (!filePath) {
    return null;
  }

  const hasOutput = Boolean(item.output) || Boolean(item.changes?.length);
  const status = resolveToolStatus(item.status, hasOutput);

  return {
    id: item.id,
    filePath,
    fileName: getFileName(filePath) || filePath,
    diff,
    status,
  };
}

export const EditToolGroupBlock = memo(function EditToolGroupBlock({
  items,
  onOpenDiffPath,
}: EditToolGroupBlockProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const previousCountRef = useRef(items.length);

  const parsedItems = useMemo(
    () => items.map(parseEditItem).filter((entry): entry is ParsedEditItem => Boolean(entry)),
    [items],
  );

  useEffect(() => {
    if (parsedItems.length > previousCountRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    previousCountRef.current = parsedItems.length;
  }, [parsedItems.length]);

  if (!parsedItems.length) {
    return null;
  }

  const totalDiff = parsedItems.reduce(
    (acc, item) => ({
      additions: acc.additions + item.diff.additions,
      deletions: acc.deletions + item.diff.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const needsScroll = parsedItems.length > MAX_VISIBLE_ITEMS;
  const listHeight = Math.min(parsedItems.length, MAX_VISIBLE_ITEMS) * ITEM_HEIGHT;

  return (
    <div className="task-container edit-group-task-container">
      <div
        className="task-header"
        onClick={() => setIsExpanded((previous) => !previous)}
        style={{
          borderBottom: isExpanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section" style={{ overflow: 'hidden' }}>
          <span className="codicon codicon-edit tool-title-icon" />
          <span className="tool-title-text" style={{ flexShrink: 0 }}>
            {t('tools.batchEditFile')}
          </span>
          <span className="tool-title-summary edit-group-item-count">({parsedItems.length})</span>
          {(totalDiff.additions > 0 || totalDiff.deletions > 0) && (
            <span className="edit-group-diff-total">
              {totalDiff.additions > 0 && <span className="diff-stat-add">+{totalDiff.additions}</span>}
              {totalDiff.deletions > 0 && <span className="diff-stat-del">-{totalDiff.deletions}</span>}
            </span>
          )}
        </div>
      </div>

      {isExpanded && (
        <div
          ref={listRef}
          className="task-details file-list-container"
          style={{
            padding: '6px 8px',
            border: 'none',
            maxHeight: needsScroll ? `${listHeight + 12}px` : undefined,
            overflowY: needsScroll ? 'auto' : 'hidden',
            overflowX: 'hidden',
          }}
        >
          {parsedItems.map((item) => (
            <div key={item.id} className="file-list-item edit-group-file-item">
              <span className="edit-group-file-icon-wrap">
                <FileIcon fileName={item.fileName} size={16} />
              </span>
              <button
                type="button"
                className={`edit-group-file-link${onOpenDiffPath ? ' is-clickable' : ''}`}
                disabled={!onOpenDiffPath}
                onClick={(event) => {
                  event.stopPropagation();
                  if (onOpenDiffPath) {
                    onOpenDiffPath(item.filePath);
                  }
                }}
                title={item.filePath}
              >
                {item.fileName}
              </button>
              <span className="edit-item-diff-stats">
                {item.diff.additions > 0 && <span className="diff-stat-add">+{item.diff.additions}</span>}
                {item.diff.deletions > 0 && <span className="diff-stat-del">-{item.diff.deletions}</span>}
              </span>
              <div className={`tool-status-indicator ${item.status === 'failed' ? 'error' : item.status}`} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export default EditToolGroupBlock;
