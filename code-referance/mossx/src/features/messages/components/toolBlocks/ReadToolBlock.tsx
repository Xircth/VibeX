/**
 * 读取文件工具块组件
 * Read Tool Block Component - for displaying file read operations
 * 使用 task-container 样式 + codicon 图标（匹配参考项目）
 */
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationItem } from '../../../../types';
import {
  parseToolArgs,
  getFirstStringField,
  getFileName,
  resolveToolStatus,
} from './toolConstants';
import { FileIcon } from './FileIcon';

interface ReadToolBlockProps {
  item: Extract<ConversationItem, { kind: 'tool' }>;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}

export const ReadToolBlock = memo(function ReadToolBlock({
  item,
  isExpanded: _isExpanded,
  onToggle: _onToggle,
}: ReadToolBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const args = useMemo(() => parseToolArgs(item.detail), [item.detail]);

  const filePath = getFirstStringField(args, ['file_path', 'path', 'target_file', 'filename']);
  const fileName = getFileName(filePath);

  const offset = args?.offset as number | undefined;
  const limit = args?.limit as number | undefined;
  let lineInfo = '';
  if (typeof offset === 'number' && typeof limit === 'number') {
    const startLine = offset + 1;
    const endLine = offset + limit;
    lineInfo = t("tools.lineRange", { start: startLine, end: endLine });
  }

  const isDirectory = filePath?.endsWith('/') || fileName === '.' || fileName === '..';
  const iconClass = isDirectory ? 'codicon-folder' : 'codicon-file-code';
  const actionText = isDirectory ? t("tools.readDirectory") : t("tools.readFile");

  const status = resolveToolStatus(item.status, Boolean(item.output));
  const isCompleted = status === 'completed';
  const isError = status === 'failed';

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          borderBottom: expanded ? '1px solid var(--border-primary)' : undefined,
        }}
      >
        <div className="task-title-section">
          <span className={`codicon ${iconClass} tool-title-icon`} />
          <span className="tool-title-text">{actionText}</span>
          {fileName && (
            <span className="tool-title-summary" style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ marginRight: '4px', display: 'flex', alignItems: 'center', width: '16px', height: '16px' }}>
                <FileIcon fileName={isDirectory ? fileName + '/' : fileName} size={16} />
              </span>
              {fileName}
            </span>
          )}
          {lineInfo && (
            <span className="tool-title-summary" style={{ marginLeft: '8px', fontSize: '12px' }}>
              {lineInfo}
            </span>
          )}
        </div>
        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>

      {expanded && item.output && (
        <div className="task-details" style={{ padding: '12px', border: 'none' }}>
          <div className="task-field-content" style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {item.output}
          </div>
        </div>
      )}
    </div>
  );
});

export default ReadToolBlock;
