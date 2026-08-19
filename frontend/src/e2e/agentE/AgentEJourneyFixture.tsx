import { useCallback, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RotateCcw, Send } from 'lucide-react';
import type { ConversationDelegationView } from 'shared/types';
import { DelegationCard } from '@/components/NormalizedConversation/conversation/DelegationCard';
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { AgentMentionProvider } from '@/components/tasks/follow-up/AgentMention';
import { SessionComposerInput } from '@/components/tasks/follow-up/SessionComposerInput';
import { Button } from '@/components/ui/button';
import type { BackendTransport } from '@/lib/backendTransport';
import '@/i18n';

const PROJECTION_KEY = 'vibex:e2e:agent-e:projection';
const PARENT_CONVERSATION_ID = 'fixture-parent-conversation';

type FixtureLog = {
  command: string;
  detail: string;
};

function readProjection(): ConversationDelegationView[] {
  try {
    const value = window.localStorage.getItem(PROJECTION_KEY);
    return value
      ? (JSON.parse(value, (_key, item: unknown) =>
          typeof item === 'string' && /^\d+n$/.test(item)
            ? BigInt(item.slice(0, -1))
            : item
        ) as ConversationDelegationView[])
      : [];
  } catch {
    return [];
  }
}

function parseMentionKinds(text: string): string[] {
  return Array.from(
    text.matchAll(/\[&(?:\\.|[^\]])+\]\(vibex:\/\/agent\/([^)]+)\)/g),
    (match) => decodeURIComponent(match[1])
  );
}

export class FakeMcpDelegationTransport implements BackendTransport {
  readonly environment = 'desktop' as const;
  private readonly onLog: (entry: FixtureLog) => void;

  constructor(onLog: (entry: FixtureLog) => void) {
    this.onLog = onLog;
  }

  async call(
    command: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    this.onLog({ command, detail: JSON.stringify(args ?? {}) });
    if (command === 'agent_management_bar') {
      return [
        {
          agent_id: 'codex',
          display_name: 'Codex',
          enabled: true,
          lifecycle: 'ready',
          active_operation: null,
        },
        {
          agent_id: 'claude_code',
          display_name: 'Claude Code',
          enabled: true,
          lifecycle: 'ready',
          active_operation: null,
        },
      ];
    }
    if (command === 'conversation_detail') {
      return {
        active_binding: {
          id: 'fixture-binding',
          delegation_mcp_delivered: true,
        },
      };
    }
    if (command === 'plugin_control_catalog') {
      return {
        plugins: [{ id: 'vibex.multi-agent', enabled: true }],
        runtimes: [],
      };
    }
    if (command === 'fixture_projection') {
      return readProjection();
    }
    if (command === 'fixture_delegate') {
      const text = typeof args?.text === 'string' ? args.text : '';
      const kinds = parseMentionKinds(text);
      const projection = kinds.slice(0, 2).map((agentKind, index) => {
        const completed = index === 0;
        return {
          delegation_id: `fixture-delegation-${index + 1}`,
          parent_tool_call_id: `fixture-tool-${index + 1}`,
          child_conversation_id: `fixture-child-${index + 1}`,
          agent_id: agentKind,
          task_preview:
            index === 0
              ? 'Review the implementation and report the result'
              : 'Inspect cancellation and preserve partial evidence',
          status: completed ? 'completed' : 'canceled',
          result: completed
            ? {
                kind: 'ok' as const,
                text_preview: 'Review complete: implementation is ready.',
                duration_ms: 1250n,
              }
            : {
                kind: 'err' as const,
                error: {
                  message: 'Canceled by the parent after evidence was saved.',
                  code: 'canceled',
                },
              },
        } satisfies ConversationDelegationView;
      });
      window.localStorage.setItem(
        PROJECTION_KEY,
        JSON.stringify(projection, (_key, value: unknown) =>
          typeof value === 'bigint' ? `${value}n` : value
        )
      );
      return projection;
    }
    if (command === 'fixture_reset') {
      window.localStorage.removeItem(PROJECTION_KEY);
      return null;
    }
    throw new Error(`Unsupported fixture command: ${command}`);
  }
}

function AgentEJourneySurface() {
  const [message, setMessage] = useState('');
  const [delegations, setDelegations] =
    useState<ConversationDelegationView[]>(readProjection);
  const [logs, setLogs] = useState<FixtureLog[]>([]);
  const [childConversationId, setChildConversationId] = useState<string | null>(
    null
  );
  const [sending, setSending] = useState(false);
  const transport = useMemo(
    () =>
      new FakeMcpDelegationTransport((entry) =>
        setLogs((current) => [...current.slice(-7), entry])
      ),
    []
  );

  const send = useCallback(async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      const projection = await transport.call('fixture_delegate', {
        parentConversationId: PARENT_CONVERSATION_ID,
        text: message,
      });
      setDelegations(projection as ConversationDelegationView[]);
    } finally {
      setSending(false);
    }
  }, [message, sending, transport]);

  const reset = useCallback(async () => {
    await transport.call('fixture_reset');
    setMessage('');
    setDelegations([]);
    setChildConversationId(null);
    setLogs([]);
  }, [transport]);

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.01em]">
              Agent Mention · Delegation Journey
            </h1>
            <p className="mt-1 max-w-[70ch] text-sm text-foreground">
              Fake MCP-capable parent · persistent projection · real VibeX
              composer and cards
            </p>
          </div>
          <Button type="button" variant="outline" onClick={reset}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset fixture
          </Button>
        </header>

        <section
          aria-label="Parent conversation"
          className="rounded-lg border border-border bg-card p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Parent conversation</h2>
              <p className="text-xs text-foreground">
                Type &amp; to select two agents. Mentions alone never create a
                running card.
              </p>
            </div>
            <span className="rounded-full bg-[hsl(var(--success)/0.14)] px-2 py-1 text-xs font-medium">
              Companion ready
            </span>
          </div>
          <div
            className="composer-shell flex flex-col gap-2 rounded-lg p-2"
            data-typeahead-surface="composer"
          >
            <AgentMentionProvider
              transport={transport}
              conversationId={PARENT_CONVERSATION_ID}
            >
              <SessionComposerInput
                value={message}
                onChange={setMessage}
                onSubmit={() => void send()}
                onAttachImages={() => {}}
              />
            </AgentMentionProvider>
            <div className="flex justify-end">
              <Button
                type="button"
                disabled={sending || !message.trim()}
                onClick={() => void send()}
              >
                <Send className="mr-1.5 h-3.5 w-3.5" />
                {sending ? 'Sending…' : 'Send to parent'}
              </Button>
            </div>
          </div>
        </section>

        <section
          aria-label="Persisted delegation projection"
          className="rounded-lg border border-border bg-card p-4"
        >
          <div className="mb-3">
            <h2 className="text-sm font-semibold">
              Persisted delegation projection
            </h2>
            <p className="text-xs text-foreground">
              Refresh the page to prove recovery after the in-memory result
              cache is gone.
            </p>
          </div>
          {delegations.length === 0 ? (
            <p className="rounded-lg bg-muted/50 px-3 py-4 text-sm text-foreground">
              No delegation has run. Select agents and send the parent prompt.
            </p>
          ) : (
            <div className="space-y-2">
              {delegations.map((delegation) => (
                <DelegationCard
                  key={delegation.delegation_id}
                  delegation={delegation}
                  onOpenChild={setChildConversationId}
                />
              ))}
            </div>
          )}
        </section>

        {childConversationId ? (
          <section
            role="region"
            aria-label="Child conversation"
            className="rounded-lg border border-border bg-card p-4"
          >
            <h2 className="text-sm font-semibold">Child conversation</h2>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {childConversationId}
            </p>
          </section>
        ) : null}

        <details className="rounded-lg border border-border bg-card px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium">
            BackendTransport log ({logs.length})
          </summary>
          <pre
            aria-label="BackendTransport log"
            className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-[11px]"
          >
            {logs.map(
              (entry, index) =>
                `${index + 1}. ${entry.command} ${entry.detail}\n`
            )}
          </pre>
        </details>
      </div>
    </main>
  );
}

export function AgentEJourneyFixture() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    []
  );

  return (
    <QueryClientProvider client={queryClient}>
      <LegacyDesignScope>
        <AgentEJourneySurface />
      </LegacyDesignScope>
    </QueryClientProvider>
  );
}
