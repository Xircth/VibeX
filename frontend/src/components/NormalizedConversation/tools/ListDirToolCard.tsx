import { useTranslation } from 'react-i18next';
import type { NormalizedEntry } from 'shared/types';
import FileIcon from '@/components/FileIcon';
import { useExpandable } from '@/stores/useExpandableStore';
import { getToolSummary } from '../conversation-entry-utils';
import { ToolCallTarget } from './ToolCallTarget';
import { listDirPath, parseDirectoryListing } from './toolDirListing';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

export function isListDirToolEntry(entry: NormalizedEntry): boolean {
  if (entry.entry_type.type !== 'tool_use') return false;
  const action = entry.entry_type.action_type;
  const name = (entry.entry_type.tool_name || '')
    .replace(/[\s._-]/g, '')
    .toLowerCase();
  if (name === 'listdir' || name === 'listdirectory' || name === 'readdir') {
    return true;
  }
  return action.action === 'tool' && action.tool_name === 'list_dir';
}

export function ListDirToolCard({
  entry,
  expansionKey,
  forceExpanded = false,
}: {
  entry: NormalizedEntry;
  expansionKey: string;
  forceExpanded?: boolean;
}) {
  const { t } = useTranslation(['conversation', 'app']);
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action =
    toolEntry?.action_type.action === 'tool' ? toolEntry.action_type : null;
  const [expanded, toggle] = useExpandable(
    `list-dir-entry:${expansionKey}`,
    false
  );
  if (!toolEntry) return null;

  const path =
    listDirPath(action?.arguments) ||
    listDirPath(action?.result?.value) ||
    entry.content.trim();
  const entries = parseDirectoryListing(
    action?.result?.value ?? action?.result ?? entry.content
  );
  const summary = getToolSummary(toolEntry, path);
  const effectiveExpanded = forceExpanded || expanded;

  return (
    <ToolCardShell
      label={t('app:entryUtils.listDir')}
      detail={
        <ToolCallTarget text={path || summary.detail} path={path} isFolder />
      }
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded={effectiveExpanded}
      expandable={entries.length > 0}
      onToggle={toggle}
    >
      {entries.length > 0 ? (
        <ul className="conv-tool-dir-list">
          {entries.map((item, index) => (
            <li
              key={`${item.kind}-${item.name}-${index}`}
              className="conv-tool-dir-row"
            >
              <FileIcon
                filePath={item.name}
                isFolder={item.kind === 'folder'}
                className="vibex-tool-call-file-icon"
              />
              <span className="conv-tool-dir-name">{item.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </ToolCardShell>
  );
}
