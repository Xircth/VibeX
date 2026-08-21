import { Hammer, ListTodo, PlayCircle, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { JsonValue, NormalizedEntry, ToolResult } from 'shared/types';
import type { ProcessStartPayload } from '@/types/logs';
import { useExpandable } from '@/stores/useExpandableStore';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { useOpenLink } from '@/hooks/useOpenLink';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import { getEntryIcon, getToolSummary } from '../conversation-entry-utils';
import {
  ToolArtifact,
  ToolFacts,
  ToolProse,
  ToolSearchHits,
  ToolTodoList,
} from './ToolArtifact';
import { ToolResultView } from './ToolResultView';
import { fileReadLocation, resolveToolFilePath } from './FileToolCard';
import { collectHttpUrls, parseToolHitItems } from './toolHitItems';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

function GenericToolDetail({
  arguments: args,
  result,
  fallbackText,
  taskAttemptId,
  openLink,
  openPath,
  openDirectory,
}: {
  arguments: JsonValue | null;
  result: ToolResult | null;
  fallbackText: string;
  taskAttemptId?: string;
  openLink: (url: string) => void;
  openPath: (path: string, line?: number) => void;
  openDirectory: (path: string) => void;
}) {
  const hits = parseToolHitItems(result?.value ?? result);
  const urlHits = collectHttpUrls(result?.value ?? args).map((url) => ({
    path: null,
    url,
    line: null,
    text: url,
  }));
  const items = hits.length > 0 ? hits : urlHits;
  if (items.length > 0) {
    return (
      <ToolSearchHits
        items={items}
        onOpenUrl={openLink}
        onOpenPath={openPath}
        onOpenDirectory={openDirectory}
      />
    );
  }

  if (result?.type.type === 'markdown' && result.value) {
    return (
      <ToolProse>
        <ToolResultView result={result} taskAttemptId={taskAttemptId} />
      </ToolProse>
    );
  }

  if (typeof result?.value === 'string' && result.value.trim()) {
    return <ToolProse>{result.value}</ToolProse>;
  }

  if (fallbackText) {
    return <ToolProse>{fallbackText}</ToolProse>;
  }

  return null;
}

function getProcessActionDetail(entry: ProcessStartPayload) {
  const actionType = entry.action?.typ;
  if (!actionType) return null;

  if (actionType.type === 'ScriptRequest') {
    return actionType.context;
  }

  return actionType.type;
}

export function GenericToolCard({
  entry,
  expansionKey,
  forceExpanded = false,
  defaultExpanded = false,
  taskAttemptId,
}: {
  entry: NormalizedEntry | ProcessStartPayload;
  expansionKey: string;
  forceExpanded?: boolean;
  defaultExpanded?: boolean;
  taskAttemptId?: string;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const openLink = useOpenLink();
  const panelActions = useOptionalPanelActionsContext();
  const isNormalizedEntry = 'entry_type' in entry;
  const toolEntry =
    isNormalizedEntry && entry.entry_type.type === 'tool_use'
      ? entry.entry_type
      : null;
  const actionType = toolEntry?.action_type ?? null;
  const [expanded, toggle] = useExpandable(
    `generic-tool-entry:${expansionKey}`,
    defaultExpanded
  );
  const effectiveExpanded = forceExpanded || expanded;

  if (!isNormalizedEntry) {
    const processDetail = getProcessActionDetail(entry);
    const hasDetails = Boolean(
      entry.runReason || entry.status || entry.startedAt || entry.action
    );

    return (
      <ToolCardShell
        icon={<PlayCircle className="h-3 w-3" />}
        label={t('genericTool.process')}
        detail={entry.runReason || processDetail || entry.status}
        expanded={effectiveExpanded}
        expandable={hasDetails}
        onToggle={toggle}
      >
        <ToolArtifact>
          <ToolFacts
            facts={[
              entry.runReason
                ? { key: t('genericTool.reason'), value: entry.runReason }
                : null,
              entry.status
                ? { key: t('genericTool.status'), value: entry.status }
                : null,
              processDetail
                ? { key: t('genericTool.action'), value: processDetail }
                : null,
              entry.startedAt
                ? { key: t('genericTool.startedAt'), value: entry.startedAt }
                : null,
            ].filter((fact): fact is { key: string; value: string } =>
              Boolean(fact)
            )}
          />
        </ToolArtifact>
      </ToolCardShell>
    );
  }

  if (!toolEntry || !actionType) return null;

  const inlineText = entry.content.trim();
  const summary = getToolSummary(toolEntry, inlineText);
  const isTaskCreate = actionType.action === 'task_create';
  const isTodo = actionType.action === 'todo_management';
  const isGenericTool = actionType.action === 'tool';
  const isOther = actionType.action === 'other';
  const label = isTaskCreate
    ? t('genericTool.subagent')
    : isTodo
      ? t('genericTool.todo')
      : summary.label;
  // The generic branch mirrors the tool name into `content`; repeating it next
  // to the label ("Write Write") carries no information — show nothing instead.
  const meaningfulInlineText = inlineText === label ? '' : inlineText;
  const detail = isTaskCreate
    ? [actionType.subagent_type, actionType.description]
        .filter(Boolean)
        .join(': ')
    : isOther
      ? actionType.description
      : // Raw tool identifiers are developer-facing noise — fall back to the
        // inline text instead of exposing `tool_name`.
        summary.detail || meaningfulInlineText;
  const genericItems =
    isGenericTool && actionType.action === 'tool'
      ? parseToolHitItems(actionType.result?.value ?? actionType.result)
      : [];
  const hasDetails =
    isTaskCreate ||
    isTodo ||
    isOther ||
    (isGenericTool &&
      (genericItems.length > 0 ||
        (actionType.action === 'tool' &&
          (actionType.result?.type.type === 'markdown' ||
            typeof actionType.result?.value === 'string' ||
            meaningfulInlineText.length > 0))));
  const icon = isTaskCreate ? (
    <Plus className="h-3 w-3" />
  ) : isTodo ? (
    <ListTodo className="h-3 w-3" />
  ) : isGenericTool ? (
    <Hammer className="h-3 w-3" />
  ) : (
    getEntryIcon(toolEntry)
  );

  return (
    <ToolCardShell
      icon={icon}
      label={label}
      detail={detail}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded={effectiveExpanded}
      expandable={hasDetails}
      onToggle={toggle}
    >
      {isTaskCreate ? (
        <ToolArtifact
          badge={actionType.subagent_type || t('genericTool.subagent')}
          title={actionType.description}
        >
          {actionType.result ? (
            <ToolProse>
              <ToolResultView
                result={actionType.result}
                taskAttemptId={taskAttemptId}
              />
            </ToolProse>
          ) : null}
        </ToolArtifact>
      ) : null}

      {isTodo ? (
        <ToolArtifact>
          <ToolTodoList todos={actionType.todos} />
        </ToolArtifact>
      ) : null}

      {isGenericTool ? (
        <GenericToolDetail
          arguments={actionType.arguments}
          result={actionType.result}
          fallbackText={meaningfulInlineText}
          taskAttemptId={taskAttemptId}
          openLink={openLink}
          openPath={(path, line) => {
            const resolved = resolveToolFilePath(path);
            const title = deriveRelativeFilePath(resolved, null) ?? path;
            panelActions?.openFilePreview(resolved, {
              displayPath: title,
              title,
              location: fileReadLocation(line, line),
            });
          }}
          openDirectory={(path) => {
            panelActions?.revealInFileTree(path, { nodeType: 'folder' });
          }}
        />
      ) : null}

      {isOther ? (
        <ToolArtifact>
          <ToolProse>{actionType.description}</ToolProse>
        </ToolArtifact>
      ) : null}
    </ToolCardShell>
  );
}
