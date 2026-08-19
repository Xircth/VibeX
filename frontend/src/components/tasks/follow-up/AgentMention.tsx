import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AgentId } from 'shared/types';
import type { BackendTransport } from '@/lib/backendTransport';
import type { TypeaheadTriggerMatch } from './typeahead-triggers';

export type AgentMention = {
  agent_kind: AgentId;
  display_name: string;
};

export type AgentMentionCandidate = AgentMention & {
  description?: string;
};

type AgentMentionContextValue = {
  candidates: AgentMentionCandidate[];
  loading: boolean;
  capability: 'unknown' | 'supported' | 'unsupported';
};

const AgentMentionContext = createContext<AgentMentionContextValue>({
  candidates: [],
  loading: false,
  capability: 'unknown',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pluginEnabled(catalog: unknown, pluginId: string): boolean {
  if (!isRecord(catalog) || !Array.isArray(catalog.plugins)) return false;
  return catalog.plugins.some(
    (plugin) =>
      isRecord(plugin) && plugin.id === pluginId && plugin.enabled === true
  );
}

function readCandidates(value: unknown): AgentMentionCandidate[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.agent_id !== 'string' ||
      typeof candidate.display_name !== 'string' ||
      candidate.enabled !== true ||
      candidate.lifecycle !== 'ready' ||
      candidate.active_operation != null
    ) {
      return [];
    }

    return [
      {
        agent_kind: candidate.agent_id,
        display_name: candidate.display_name,
      },
    ];
  });
}

export function AgentMentionProvider({
  transport,
  conversationId,
  children,
}: {
  transport: BackendTransport;
  conversationId?: string | null;
  children: ReactNode;
}) {
  const [candidates, setCandidates] = useState<AgentMentionCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [capability, setCapability] =
    useState<AgentMentionContextValue['capability']>('unknown');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setCapability('unknown');
    void transport
      .call('agent_management_bar')
      .then((value) => {
        if (active) setCandidates(readCandidates(value));
      })
      .catch(() => {
        if (active) setCandidates([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    void Promise.all([
      conversationId
        ? transport.call('conversation_detail', { sessionId: conversationId })
        : Promise.resolve(null),
      transport.call('plugin_control_catalog'),
    ])
      .then(([detail, catalog]) => {
        if (!active) return;
        const pluginOn = pluginEnabled(catalog, 'vibex.multi-agent');
        if (!pluginOn) {
          setCapability('unsupported');
          return;
        }
        if (!conversationId) {
          setCapability('unsupported');
          return;
        }
        if (!isRecord(detail)) {
          setCapability('unsupported');
          return;
        }
        const binding = detail.active_binding;
        const delivered =
          isRecord(binding) && binding.delegation_mcp_delivered === true;
        setCapability(delivered ? 'supported' : 'unsupported');
      })
      .catch(() => {
        if (active) setCapability('unsupported');
      });

    return () => {
      active = false;
    };
  }, [conversationId, transport]);

  const value = useMemo(
    () => ({ candidates, loading, capability }),
    [candidates, capability, loading]
  );

  return (
    <AgentMentionContext.Provider value={value}>
      {children}
    </AgentMentionContext.Provider>
  );
}

export function useAgentMentions(): AgentMentionContextValue {
  return useContext(AgentMentionContext);
}

function escapeMentionLabel(value: string): string {
  return value.replace(/[\\\]]/g, '\\$&');
}

export function serializeAgentMention(mention: AgentMention): string {
  return `[&${escapeMentionLabel(mention.display_name)}](vibex://agent/${encodeURIComponent(
    mention.agent_kind
  )})`;
}

export function isAgentMentionCodeContext(
  source: string,
  offset: number
): boolean {
  const lines = source.slice(0, offset).split('\n');
  let fence: { marker: '`' | '~'; size: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1].charAt(0) as '`' | '~';
      const size = fenceMatch[1].length;
      const trailing = line.slice(fenceMatch[0].length);
      if (!fence) {
        fence = { marker, size };
      } else if (
        fence.marker === marker &&
        size >= fence.size &&
        /^[ \t]*$/.test(trailing)
      ) {
        fence = null;
      }
      continue;
    }

    if (index === lines.length - 1 && !fence) {
      if (/^(?: {4}|\t)/.test(line)) return true;
      let inlineDelimiter = 0;
      for (let cursor = 0; cursor < line.length; ) {
        if (line.charAt(cursor) !== '`') {
          cursor += 1;
          continue;
        }
        let runEnd = cursor + 1;
        while (line.charAt(runEnd) === '`') runEnd += 1;
        const runLength = runEnd - cursor;
        inlineDelimiter =
          inlineDelimiter === runLength
            ? 0
            : inlineDelimiter === 0
              ? runLength
              : inlineDelimiter;
        cursor = runEnd;
      }
      return inlineDelimiter > 0;
    }
  }

  return fence !== null;
}

export function matchAgentMentionTrigger(
  text: string
): TypeaheadTriggerMatch | null {
  const match = /(?:^|[\s([{])&([^\s&]*)$/.exec(text);
  if (!match) return null;

  const triggerOffset = match.index + match[0].indexOf('&');
  if (isAgentMentionCodeContext(text, triggerOffset)) return null;
  return {
    leadOffset: triggerOffset,
    matchingString: match[1],
    replaceableString: match[0].slice(match[0].indexOf('&')),
  };
}
