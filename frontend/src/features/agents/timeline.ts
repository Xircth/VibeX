import type { ContentBlock, MessageTurn } from 'shared/types';
import type { AgentContentBlock, AgentEventEnvelope } from './types';

/**
 * The unified conversation timeline (codeg-aligned). A conversation's rendered
 * turns are the merge of four phases:
 *   - persisted:  re-parsed from the agent's own session file (conversation_detail)
 *   - local:      turns the active session has completed but the DB hasn't re-parsed yet
 *   - optimistic: user messages sent but not yet acknowledged
 *   - streaming:  the in-flight assistant reply, derived live from the event stream
 *
 * `getTimelineTurns` flattens these into one de-duplicated, render-stable list.
 *
 * VibeX-authored. Unlike codeg (which buffers a dedicated LiveMessage), VibeX
 * derives the streaming turn directly from the accumulated `eventsByScope`
 * envelopes, matching the app's existing transport store.
 */

export type TimelinePhase = 'persisted' | 'optimistic' | 'streaming';

export interface ConversationTimelineTurn {
  /** Stable React key for the rendered row. */
  key: string;
  turn: MessageTurn;
  phase: TimelinePhase;
  /** Tool calls still producing output (streaming phase only). */
  inProgressToolCallIds?: Set<string>;
}

export interface StreamingTurns {
  turns: MessageTurn[];
  inProgressToolCallIds: Set<string>;
}

export interface GetTimelineTurnsInput {
  conversationId: string;
  /** Re-parsed historical turns (`conversation_detail.turns`). */
  persisted: MessageTurn[];
  /** Completed-but-not-yet-persisted turns held by the active runtime. */
  local?: MessageTurn[];
  /** User turns sent but not yet acknowledged by the backend. */
  optimistic?: MessageTurn[];
  /** The in-flight assistant reply, if a turn is streaming. */
  streaming?: StreamingTurns | null;
  /** The persisted user turn currently being answered (mid-turn reconciliation). */
  inFlightUserTurnId?: string | null;
}

/** Collision-proof de-dup key over `(role, id)` — no separator to clash with ids. */
function retainKey(turn: MessageTurn): string {
  return JSON.stringify([turn.role, turn.id]);
}

/**
 * Merge the four phases into one timeline, de-duplicated by `(role, id)`.
 *
 * Retention is role-aware: assistant/system turns keep the LAST occurrence (a
 * fresher streamed copy supersedes an earlier promoted snapshot), while user
 * turns keep the FIRST (the persisted prompt must stay above its own reply).
 */
export function getTimelineTurns(
  input: GetTimelineTurnsInput
): ConversationTimelineTurn[] {
  const {
    conversationId,
    persisted,
    local = [],
    optimistic = [],
    streaming = null,
    inFlightUserTurnId = null,
  } = input;

  // While a live reply is in hand, drop the stale persisted partial some agents
  // write mid-turn: any persisted assistant turn after the in-flight user prompt
  // is superseded by the streaming reply.
  let persistedTurns = persisted;
  if (streaming && streaming.turns.length > 0 && inFlightUserTurnId) {
    const promptIndex = persistedTurns.findIndex(
      (turn) => turn.role === 'user' && turn.id === inFlightUserTurnId
    );
    if (promptIndex !== -1) {
      persistedTurns = persistedTurns.filter(
        (turn, index) => index <= promptIndex || turn.role !== 'assistant'
      );
    }
  }

  const result: ConversationTimelineTurn[] = [];
  persistedTurns.forEach((turn, index) =>
    result.push({
      key: `persisted-${conversationId}-${turn.id}-${index}`,
      turn,
      phase: 'persisted',
    })
  );
  // Promoted-but-unpersisted turns render identically to persisted ones.
  local.forEach((turn, index) =>
    result.push({
      key: `local-${conversationId}-${turn.id}-${index}`,
      turn,
      phase: 'persisted',
    })
  );
  optimistic.forEach((turn, index) =>
    result.push({
      key: `optimistic-${conversationId}-${turn.id}-${index}`,
      turn,
      phase: 'optimistic',
    })
  );
  if (streaming) {
    streaming.turns.forEach((turn, index) =>
      result.push({
        key: `streaming-${conversationId}-${turn.id}-${index}`,
        turn,
        phase: 'streaming',
        inProgressToolCallIds: streaming.inProgressToolCallIds,
      })
    );
  }

  const retainIndexByKey = new Map<string, number>();
  result.forEach((entry, index) => {
    const key = retainKey(entry.turn);
    if (entry.turn.role !== 'user') {
      retainIndexByKey.set(key, index); // non-user: keep last
    } else if (!retainIndexByKey.has(key)) {
      retainIndexByKey.set(key, index); // user: keep first
    }
  });

  return result.filter(
    (entry, index) => retainIndexByKey.get(retainKey(entry.turn)) === index
  );
}

function textOf(content: AgentContentBlock): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'image':
      return content.uri ? `[image] ${content.uri}` : '[image]';
    case 'resource':
      return content.title
        ? `[resource] ${content.title}: ${content.uri}`
        : `[resource] ${content.uri}`;
  }
}

function mergeText(
  blocks: ContentBlock[],
  type: 'text' | 'thinking',
  text: string
): void {
  const last = blocks.at(-1);
  if (last && last.type === type) {
    last.text = `${last.text}${text}`;
    return;
  }
  blocks.push({ type, text });
}

const FINAL_TOOL_STATUSES = new Set(['completed', 'failed']);

/** The prompt currently being answered: the last `prompt_started` not yet finished. */
export interface ActivePrompt {
  id: string;
  /** Index of the `prompt_started` envelope within `envelopes`. */
  index: number;
  textPreview: string;
  startedAt: string;
}

/**
 * Locate the active prompt — the latest `prompt_started` with no matching
 * `prompt_finished`. Returns null when the conversation is idle.
 */
export function findActivePrompt(
  envelopes: AgentEventEnvelope[]
): ActivePrompt | null {
  const finishedPromptIds = new Set<string>();
  for (const envelope of envelopes) {
    if (envelope.event.kind === 'prompt_finished') {
      finishedPromptIds.add(String(envelope.event.finished.prompt_id));
    }
  }

  let active: ActivePrompt | null = null;
  envelopes.forEach((envelope, index) => {
    if (
      envelope.event.kind === 'prompt_started' &&
      !finishedPromptIds.has(String(envelope.event.snapshot.id))
    ) {
      active = {
        id: String(envelope.event.snapshot.id),
        index,
        textPreview: envelope.event.snapshot.text_preview,
        startedAt: envelope.event.snapshot.created_at,
      };
    }
  });
  return active;
}

/**
 * Derive the in-flight assistant turn from accumulated event envelopes.
 *
 * Reads the events of the latest still-running prompt and folds them into a
 * single assistant `MessageTurn`, matching how the backend parser groups a
 * completed round. Returns no turns when no prompt is active — the finished
 * reply then comes from the persisted/local phases instead.
 */
export function buildStreamingTurns(
  envelopes: AgentEventEnvelope[],
  conversationId: string
): StreamingTurns {
  const inProgressToolCallIds = new Set<string>();

  const active = findActivePrompt(envelopes);
  if (active === null) {
    return { turns: [], inProgressToolCallIds };
  }
  const activeStartIndex = active.index;
  const activePromptId = active.id;
  const activeStartedAt = active.startedAt;

  const blocks: ContentBlock[] = [];
  const resultIndexByToolId = new Map<string, number>();

  for (let i = activeStartIndex + 1; i < envelopes.length; i += 1) {
    const event = envelopes[i].event;
    switch (event.kind) {
      case 'message_chunk':
        if (event.content.kind === 'image') {
          blocks.push({
            type: 'image',
            data: event.content.data,
            mime_type: event.content.mime_type,
            uri: event.content.uri,
          });
        } else {
          mergeText(blocks, 'text', textOf(event.content));
        }
        break;
      case 'thought_chunk':
        mergeText(blocks, 'thinking', textOf(event.content));
        break;
      case 'tool_call':
        blocks.push({
          type: 'tool_use',
          tool_use_id: event.tool_call.id,
          tool_name: event.tool_call.title,
          input_preview: event.tool_call.kind ?? null,
          meta: null,
        });
        break;
      case 'tool_call_update': {
        const id = event.update.id;
        const status = event.update.status ?? null;
        const isFinal = status !== null && FINAL_TOOL_STATUSES.has(status);
        const block: ContentBlock = {
          type: 'tool_result',
          tool_use_id: id,
          output_preview: event.update.content ?? null,
          is_error: status === 'failed',
          agent_stats: null,
        };
        const existing = resultIndexByToolId.get(id);
        if (existing !== undefined) {
          blocks[existing] = block;
        } else {
          resultIndexByToolId.set(id, blocks.length);
          blocks.push(block);
        }
        if (isFinal) {
          inProgressToolCallIds.delete(id);
        } else {
          inProgressToolCallIds.add(id);
        }
        break;
      }
      default:
        break;
    }
  }

  if (blocks.length === 0) {
    return { turns: [], inProgressToolCallIds };
  }

  const turn: MessageTurn = {
    id: `live-${conversationId}-${activePromptId}`,
    role: 'assistant',
    blocks,
    timestamp: activeStartedAt,
    usage: null,
    duration_ms: null,
    model: null,
    completed_at: null,
  };
  return { turns: [turn], inProgressToolCallIds };
}
