import type { NormalizedEntry } from 'shared/types.ts';
import { Globe } from 'lucide-react';
import { ToolCardShell, getToolStatusClassName, getToolStatusDotClassName } from './ToolCardShell';
import { ToolArtifact, ToolFacts, ToolProse } from './ToolArtifact';
import { useExpandable } from '@/stores/useExpandableStore';

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
  const effectiveExpanded = forceExpanded || expanded;
  const facts = [
    typeof args.tabId === 'string'
      ? { key: 'tab', value: args.tabId }
      : null,
    typeof args.ref === 'string' ? { key: 'ref', value: args.ref } : null,
    typeof args.url === 'string' ? { key: 'url', value: args.url } : null,
  ].filter((item): item is { key: string; value: string } => Boolean(item));
  const code = typeof args.code === 'string' ? args.code : '';
  const resultText =
    typeof result?.value === 'string'
      ? result.value
      : result?.value
        ? JSON.stringify(result.value)
        : entry.content;
  const name = action?.tool_name || toolEntry?.tool_name || 'browser';
  return (
    <ToolCardShell
      icon={<Globe className="h-3 w-3" />}
      label={name.replace(/^.*browser_/, 'browser_')}
      detail={
        typeof args.url === 'string'
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
            <ToolProse>
              <pre className="whitespace-pre-wrap text-xs">{code}</pre>
            </ToolProse>
          ) : null}
          {resultText ? <ToolProse>{resultText}</ToolProse> : null}
        </ToolArtifact>
      ) : null}
    </ToolCardShell>
  );
}
