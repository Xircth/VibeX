import type { NormalizedEntry } from 'shared/types.ts';
import { Globe } from 'lucide-react';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
  useToolCallResultDetail,
} from './ToolCardShell';
import { ToolArtifact, ToolFacts, ToolCodeSnippet } from './ToolArtifact';
import { useExpandable } from '@/stores/useExpandableStore';
import { ToolResultView } from './ToolResultView';
import { jsonToFacts } from './toolArtifactModel';
import { getToolCallDescription } from '../conversation-entry-utils';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isBrowserToolEntry(entry: NormalizedEntry): boolean {
  if (entry.entry_type.type !== 'tool_use') return false;
  const name =
    (entry.entry_type.action_type.action === 'tool'
      ? entry.entry_type.action_type.tool_name
      : entry.entry_type.tool_name) || '';
  return /(^|__)browser_(list_tabs|snapshot|click|type|eval|open_tab|navigate|close_tab)$/.test(
    name
  );
}

export function BrowserToolCard({
  entry,
  expansionKey,
  forceExpanded = false,
}: {
  entry: NormalizedEntry;
  expansionKey: string;
  forceExpanded?: boolean;
}) {
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action =
    toolEntry?.action_type.action === 'tool' ? toolEntry.action_type : null;
  const args = isRecord(action?.arguments) ? action.arguments : {};
  const result = action?.result;
  const [expanded, toggle] = useExpandable(
    `browser-tool:${expansionKey}`,
    false
  );
  const isResultDetail = useToolCallResultDetail();
  const effectiveExpanded = forceExpanded || isResultDetail || expanded;
  const facts = jsonToFacts(action?.arguments, {
    skipKeys: ['code', 'description'],
  });
  const code = typeof args.code === 'string' ? args.code : '';
  const name = action?.tool_name || toolEntry?.tool_name || 'browser';
  const description = getToolCallDescription(entry);
  return (
    <ToolCardShell
      icon={<Globe className="h-3 w-3" />}
      label={description ?? name.replace(/^.*browser_/, 'browser_')}
      detail={
        description
          ? undefined
          : typeof args.url === 'string'
            ? args.url
            : typeof args.tabId === 'string'
              ? args.tabId
              : undefined
      }
      statusClassName={getToolStatusClassName(toolEntry?.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry?.status)}
      status={toolEntry?.status}
      expanded={effectiveExpanded}
      expandable
      onToggle={toggle}
    >
      {effectiveExpanded ? (
        <ToolArtifact>
          {facts.length > 0 ? <ToolFacts facts={facts} /> : null}
          {code ? (
            <ToolCodeSnippet language="javascript" content={code} />
          ) : null}
          {result?.type.type === 'json' ? (
            <ToolFacts facts={jsonToFacts(result.value)} />
          ) : (
            <ToolResultView result={result} />
          )}
        </ToolArtifact>
      ) : null}
    </ToolCardShell>
  );
}
