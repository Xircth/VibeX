import type {
  ContentBlock,
  ConversationEventEnvelope,
  ConversationTimeline,
  ConversationTimelineRow,
  DbConversationDetail,
  MessageTurn,
} from 'shared/types';

export type ConversationGapState =
  | { kind: 'none' }
  | { kind: 'gap'; expectedSequence: bigint; receivedSequence: bigint }
  | { kind: 'refetch_required'; reason: string };

export type ConversationTimelineTurn = {
  key: string;
  turn: MessageTurn;
  phase: 'persisted' | 'optimistic' | 'streaming' | 'settled';
};

export type ConversationStoreEntry = {
  conversationId: string;
  detail: DbConversationDetail | null;
  rows: ConversationTimelineRow[];
  lastSequence: bigint;
  projectionVersion: number | null;
  currentTurnId: string | null;
  loading: boolean;
  error: string | null;
  gap: ConversationGapState;
  optimisticTurns: MessageTurn[];
};

export type ConversationStoreState = {
  byConversationId: Record<string, ConversationStoreEntry>;
};

export type ConversationStoreAction =
  | { type: 'load_start'; conversationId: string }
  | { type: 'load_success'; conversationId: string; detail: DbConversationDetail }
  | { type: 'load_error'; conversationId: string; error: string }
  | { type: 'event'; envelope: ConversationEventEnvelope }
  | { type: 'events'; conversationId: string; events: ConversationEventEnvelope[] }
  | { type: 'optimistic_turn'; conversationId: string; turn: MessageTurn }
  | { type: 'remove_optimistic_turn'; conversationId: string; turnId: string }
  | { type: 'reset'; conversationId: string };

export const emptyConversationStoreState: ConversationStoreState = {
  byConversationId: {},
};

export function conversationStoreReducer(
  state: ConversationStoreState,
  action: ConversationStoreAction
): ConversationStoreState {
  switch (action.type) {
    case 'load_start':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        loading: true,
        error: null,
      }));
    case 'load_success':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        detail: action.detail,
        rows: action.detail.timeline.rows,
        lastSequence: toBigInt(action.detail.timeline.last_sequence),
        projectionVersion: action.detail.projection_version,
        currentTurnId: action.detail.current_turn?.id ?? null,
        loading: false,
        error: null,
        gap: { kind: 'none' },
        optimisticTurns: reconcileOptimisticTurns(
          entry.optimisticTurns,
          action.detail.timeline
        ),
      }));
    case 'load_error':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        loading: false,
        error: action.error,
      }));
    case 'event':
      return updateEntry(state, action.envelope.conversation_id, (entry) =>
        applyConversationEvent(entry, action.envelope)
      );
    case 'events':
      return updateEntry(state, action.conversationId, (entry) =>
        action.events.reduce(applyConversationEvent, entry)
      );
    case 'optimistic_turn':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        optimisticTurns: [...entry.optimisticTurns, action.turn],
      }));
    case 'remove_optimistic_turn':
      return updateEntry(state, action.conversationId, (entry) => ({
        ...entry,
        optimisticTurns: entry.optimisticTurns.filter(
          (turn) => turn.id !== action.turnId
        ),
      }));
    case 'reset': {
      const next = { ...state.byConversationId };
      delete next[action.conversationId];
      return { byConversationId: next };
    }
  }
}

export function timelineTurnsForEntry(
  entry: ConversationStoreEntry | null
): ConversationTimelineTurn[] {
  if (!entry) return [];
  const persisted = entry.rows.flatMap((row, index) =>
    row.kind === 'message_turn'
      ? [
          {
            key: `conversation-${row.turn.id}-${index}`,
            turn: row.turn,
            phase: row.phase as ConversationTimelineTurn['phase'],
          },
        ]
      : []
  );
  const optimistic = entry.optimisticTurns.map((turn, index) => ({
    key: `optimistic-${turn.id}-${index}`,
    turn,
    phase: 'optimistic' as const,
  }));
  return dedupeTurns([...persisted, ...optimistic]);
}

export function sideRowsForEntry(
  entry: ConversationStoreEntry | null
): ConversationTimelineRow[] {
  return entry?.rows.filter((row) => row.kind !== 'message_turn') ?? [];
}

function createEntry(conversationId: string): ConversationStoreEntry {
  return {
    conversationId,
    detail: null,
    rows: [],
    lastSequence: 0n,
    projectionVersion: null,
    currentTurnId: null,
    loading: false,
    error: null,
    gap: { kind: 'none' },
    optimisticTurns: [],
  };
}

function updateEntry(
  state: ConversationStoreState,
  conversationId: string,
  update: (entry: ConversationStoreEntry) => ConversationStoreEntry
): ConversationStoreState {
  const current = state.byConversationId[conversationId] ?? createEntry(conversationId);
  return {
    byConversationId: {
      ...state.byConversationId,
      [conversationId]: update(current),
    },
  };
}

function applyConversationEvent(
  entry: ConversationStoreEntry,
  envelope: ConversationEventEnvelope
): ConversationStoreEntry {
  const sequence = toBigInt(envelope.sequence);
  if (sequence <= entry.lastSequence) return entry;

  const expected = entry.lastSequence + 1n;
  if (entry.lastSequence > 0n && sequence > expected) {
    return {
      ...entry,
      gap: {
        kind: 'gap',
        expectedSequence: expected,
        receivedSequence: sequence,
      },
    };
  }

  const turnId = envelope.turn_id ?? entry.currentTurnId;
  const rows = applyEventRows(entry.rows, envelope, turnId);
  return {
    ...entry,
    rows,
    lastSequence: sequence,
    currentTurnId: turnId ?? entry.currentTurnId,
    gap: { kind: 'none' },
    optimisticTurns:
      envelope.event.kind === 'user_turn_created'
        ? entry.optimisticTurns.filter((turn) => turn.id !== `optimistic-${turnId}`)
        : entry.optimisticTurns,
  };
}

function applyEventRows(
  rows: ConversationTimelineRow[],
  envelope: ConversationEventEnvelope,
  turnId: string | null
): ConversationTimelineRow[] {
  const event = envelope.event;
  switch (event.kind) {
    case 'user_turn_created':
      if (!turnId) return rows;
      return upsertMessageTurn(rows, userTurnFromEvent(turnId, envelope));
    case 'assistant_text_delta':
      if (!turnId) return rows;
      return updateAssistantTurn(rows, turnId, envelope.created_at, (turn) => ({
        ...turn,
        blocks: appendTextBlock(turn.blocks, event.text),
      }));
    case 'assistant_reasoning_delta':
      if (!turnId) return rows;
      return updateAssistantTurn(rows, turnId, envelope.created_at, (turn) => ({
        ...turn,
        blocks: appendThinkingBlock(turn.blocks, event.text),
      }));
    case 'plan_updated':
      if (!turnId) return rows;
      return updateAssistantTurn(rows, turnId, envelope.created_at, (turn) => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          {
            type: 'plan',
            entries: event.entries.map((entry) => ({
              content: entry.content,
              status: entry.status,
              priority: entry.priority,
            })),
          },
        ],
      }));
    case 'tool_call_upsert':
      if (!turnId) return rows;
      return updateAssistantTurn(rows, turnId, envelope.created_at, (turn) => ({
        ...turn,
        blocks: [...turn.blocks, ...toolBlocks(event.tool_call)],
      }));
    case 'usage_updated':
      if (!turnId) return rows;
      return updateAssistantTurn(rows, turnId, envelope.created_at, (turn) => ({
        ...turn,
        usage: {
          input_tokens: event.usage.input_tokens,
          output_tokens: event.usage.output_tokens,
          cache_creation_input_tokens: event.usage.cache_creation_input_tokens,
          cache_read_input_tokens: event.usage.cache_read_input_tokens,
        },
      }));
    case 'turn_completed':
      return setTurnPhase(rows, turnId, 'settled');
    case 'turn_failed':
      return [
        ...setTurnPhase(rows, turnId, 'settled'),
        {
          kind: 'turn_error',
          error: { turn_id: turnId, error: event.error },
        },
      ];
    case 'turn_cancelled':
      return [
        ...setTurnPhase(rows, turnId, 'settled'),
        {
          kind: 'turn_error',
          error: {
            turn_id: turnId,
            error: {
              message: event.reason ?? 'Turn cancelled',
              code: 'cancelled',
            },
          },
        },
      ];
    case 'permission_requested':
      return [
        ...rows,
        {
          kind: 'permission_request',
          request: {
            permission_id: event.request.permission_id,
            title: event.request.request.title,
            status: 'pending',
          },
        },
      ];
    case 'permission_responded':
      return rows.map((row) =>
        row.kind === 'permission_request' &&
        row.request.permission_id === event.permission_id
          ? {
              ...row,
              request: { ...row.request, status: 'responded' },
            }
          : row
      );
    case 'question_requested':
      return [...rows, { kind: 'question_request', request: event.request }];
    case 'feedback_requested':
      return [...rows, { kind: 'feedback_request', request: event.request }];
    case 'terminal_updated':
      return [
        ...rows,
        {
          kind: 'terminal_summary',
          terminal: {
            terminal_id: event.terminal.terminal_id,
            command: event.terminal.command ?? null,
            status: event.terminal.status,
            output_summary: event.terminal.output_summary ?? null,
            output_truncated: event.terminal.output_truncated,
          },
        },
      ];
    case 'delegation_started':
      return [
        ...rows,
        {
          kind: 'delegation',
          delegation: {
            delegation_id: event.delegation.delegation_id,
            parent_tool_call_id: event.delegation.parent_tool_call_id,
            child_conversation_id: event.delegation.child_conversation_id,
            agent_type: event.delegation.agent_type,
            task_preview: event.delegation.task_preview,
            status: 'running',
            result: null,
          },
        },
      ];
    case 'delegation_completed':
      return [
        ...rows,
        {
          kind: 'delegation',
          delegation: {
            delegation_id: event.delegation_id,
            parent_tool_call_id: null,
            child_conversation_id: null,
            agent_type: null,
            task_preview: null,
            status: 'completed',
            result: event.result,
          },
        },
      ];
    case 'file_change_summary_updated':
      return [...rows, { kind: 'file_change_summary', summary: event.summary }];
    case 'agent_binding_load_failed':
      return [
        ...rows,
        {
          kind: 'session_notice',
          notice: {
            title: 'Agent session load failed',
            message: JSON.stringify(event.reason),
            severity: 'warning',
          },
        },
      ];
    case 'agent_binding_recovery_failed':
      return [
        ...rows,
        {
          kind: 'session_notice',
          notice: {
            title: 'Agent session recovery failed',
            message: event.reason,
            severity: 'error',
          },
        },
      ];
    case 'session_config_stale':
      return event.stale
        ? [
            ...rows,
            {
              kind: 'session_notice',
              notice: {
                title: 'Agent configuration changed',
                message: event.reason ?? null,
                severity: 'info',
              },
            },
          ]
        : rows;
    case 'raw_diagnostic_recorded':
      return [
        ...rows,
        {
          kind: 'session_notice',
          notice: {
            title: 'Agent diagnostic',
            message: event.label,
            severity: 'info',
          },
        },
      ];
    default:
      return rows;
  }
}

function userTurnFromEvent(
  turnId: string,
  envelope: ConversationEventEnvelope
): ConversationTimelineRow {
  const event = envelope.event;
  const blocks: ContentBlock[] =
    event.kind === 'user_turn_created'
      ? event.blocks.flatMap<ContentBlock>((block) => {
          if (block.kind === 'text') return [{ type: 'text', text: block.text }];
          if (block.kind === 'image') {
            return [
              {
                type: 'image',
                data: '',
                mime_type: block.mime_type,
                uri: block.uri,
              },
            ];
          }
          return [];
        })
      : [];
  return {
    kind: 'message_turn',
    phase: 'streaming',
    turn: {
      id: `${turnId}:user`,
      role: 'user',
      blocks,
      timestamp: envelope.created_at,
    },
  };
}

function upsertMessageTurn(
  rows: ConversationTimelineRow[],
  row: ConversationTimelineRow
): ConversationTimelineRow[] {
  if (row.kind !== 'message_turn') return rows;
  const index = rows.findIndex(
    (candidate) =>
      candidate.kind === 'message_turn' && candidate.turn.id === row.turn.id
  );
  if (index === -1) return [...rows, row];
  const next = [...rows];
  next[index] = row;
  return next;
}

function updateAssistantTurn(
  rows: ConversationTimelineRow[],
  turnId: string,
  timestamp: string,
  update: (turn: MessageTurn) => MessageTurn
): ConversationTimelineRow[] {
  const assistantId = `${turnId}:assistant`;
  const index = rows.findIndex(
    (row) => row.kind === 'message_turn' && row.turn.id === assistantId
  );
  if (index === -1) {
    return [
      ...rows,
      {
        kind: 'message_turn',
        phase: 'streaming',
        turn: update({
          id: assistantId,
          role: 'assistant',
          blocks: [],
          timestamp,
        }),
      },
    ];
  }
  return rows.map((row, rowIndex) =>
    rowIndex === index && row.kind === 'message_turn'
      ? { ...row, turn: update(row.turn), phase: row.phase || 'streaming' }
      : row
  );
}

function setTurnPhase(
  rows: ConversationTimelineRow[],
  turnId: string | null,
  phase: string
): ConversationTimelineRow[] {
  if (!turnId) return rows;
  return rows.map((row) =>
    row.kind === 'message_turn' && row.turn.id.startsWith(`${turnId}:`)
      ? { ...row, phase }
      : row
  );
}

function appendTextBlock(blocks: ContentBlock[], text: string): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last?.type === 'text') {
    return [...blocks.slice(0, -1), { ...last, text: `${last.text}${text}` }];
  }
  return [...blocks, { type: 'text', text }];
}

function appendThinkingBlock(blocks: ContentBlock[], text: string): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last?.type === 'thinking') {
    return [...blocks.slice(0, -1), { ...last, text: `${last.text}${text}` }];
  }
  return [...blocks, { type: 'thinking', text }];
}

function toolBlocks(
  toolCall: Extract<
    ConversationEventEnvelope['event'],
    { kind: 'tool_call_upsert' }
  >['tool_call']
): ContentBlock[] {
  const blocks: ContentBlock[] = [
    {
      type: 'tool_use',
      tool_use_id: toolCall.tool_call_id,
      tool_name: toolCall.title ?? toolCall.kind ?? toolCall.tool_call_id,
      input_preview: toolCall.raw_input ? JSON.stringify(toolCall.raw_input) : null,
      meta: toolCall.metadata ?? null,
    },
  ];
  if (toolCall.raw_output) {
    blocks.push({
      type: 'tool_result',
      tool_use_id: toolCall.tool_call_id,
      output_preview: JSON.stringify(toolCall.raw_output),
      is_error: toolCall.status === 'failed',
      agent_stats: null,
    });
  }
  return blocks;
}

function reconcileOptimisticTurns(
  optimisticTurns: MessageTurn[],
  timeline: ConversationTimeline
): MessageTurn[] {
  const persistedText = new Set(
    timeline.rows.flatMap((row) =>
      row.kind === 'message_turn' && row.turn.role === 'user'
        ? [
            row.turn.blocks
              .flatMap((block) => (block.type === 'text' ? [block.text] : []))
              .join('\n')
              .trim(),
          ]
        : []
    )
  );
  return optimisticTurns.filter((turn) => {
    const text = turn.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
    return !persistedText.has(text);
  });
}

function dedupeTurns(turns: ConversationTimelineTurn[]): ConversationTimelineTurn[] {
  const retain = new Map<string, number>();
  turns.forEach((entry, index) => {
    const key = `${entry.turn.role}:${entry.turn.id}`;
    if (!retain.has(key) || entry.turn.role !== 'user') {
      retain.set(key, index);
    }
  });
  return turns.filter((entry, index) => {
    const key = `${entry.turn.role}:${entry.turn.id}`;
    return retain.get(key) === index;
  });
}

function toBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
