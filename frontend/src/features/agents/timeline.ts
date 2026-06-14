import type { ContentBlock, MessageTurn } from 'shared/types';
import type { AgentContentBlock, AgentEvent, AgentEventEnvelope } from './types';

/**
 * Unified ACP-native conversation timeline.
 *
 * While a session is live, the event stream is the source of truth: every
 * `prompt_started` opens a user turn and subsequent ACP updates are folded into
 * that prompt's assistant turn. The parsed transcript remains the cold-open
 * history source and is prepended when it clearly predates the live events.
 */

export type TimelinePhase = 'persisted' | 'streaming';

export interface ConversationTimelineTurn {
  key: string;
  turn: MessageTurn;
  phase: TimelinePhase;
  inProgressToolCallIds?: Set<string>;
}

export interface LiveTurns {
  turns: MessageTurn[];
  inProgressToolCallIds: Set<string>;
}

export interface GetTimelineTurnsInput {
  conversationId: string;
  persisted: MessageTurn[];
  live: MessageTurn[];
  inProgressToolCallIds?: Set<string>;
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

interface ReplyAccumulator {
  promptId: string;
  blocks: ContentBlock[];
  resultIndexByToolId: Map<string, number>;
  planIndex: number;
  startedAt: string;
  finished: boolean;
}

function appendReplyEvent(
  acc: ReplyAccumulator,
  event: AgentEvent,
  inProgressToolCallIds: Set<string>
): void {
  switch (event.kind) {
    case 'plan': {
      const plan: ContentBlock = {
        type: 'plan',
        entries: event.plan.entries.map((content) => ({
          content,
          status: 'pending',
          priority: null,
        })),
      };
      if (acc.planIndex >= 0) {
        acc.blocks[acc.planIndex] = plan;
      } else {
        acc.planIndex = acc.blocks.length;
        acc.blocks.push(plan);
      }
      break;
    }
    case 'message_chunk':
      if (event.content.kind === 'image') {
        acc.blocks.push({
          type: 'image',
          data: event.content.data,
          mime_type: event.content.mime_type,
          uri: event.content.uri,
        });
      } else {
        mergeText(acc.blocks, 'text', textOf(event.content));
      }
      break;
    case 'thought_chunk':
      mergeText(acc.blocks, 'thinking', textOf(event.content));
      break;
    case 'tool_call':
      acc.blocks.push({
        type: 'tool_use',
        tool_use_id: event.tool_call.id,
        tool_name: event.tool_call.title,
        input_preview:
          event.tool_call.input_preview ?? event.tool_call.kind ?? null,
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
      const existing = acc.resultIndexByToolId.get(id);
      if (existing !== undefined) {
        acc.blocks[existing] = block;
      } else {
        acc.resultIndexByToolId.set(id, acc.blocks.length);
        acc.blocks.push(block);
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

export function buildTurnsFromEvents(
  envelopes: AgentEventEnvelope[],
  conversationId: string
): LiveTurns {
  const finishedPromptIds = new Set<string>();
  for (const envelope of envelopes) {
    if (envelope.event.kind === 'prompt_finished') {
      finishedPromptIds.add(String(envelope.event.finished.prompt_id));
    }
  }

  const turns: MessageTurn[] = [];
  let inProgressToolCallIds = new Set<string>();
  let current: ReplyAccumulator | null = null;

  const flush = () => {
    if (current && current.blocks.length > 0) {
      turns.push({
        id: `a-${conversationId}-${current.promptId}`,
        role: 'assistant',
        blocks: current.blocks,
        timestamp: current.startedAt,
        usage: null,
        duration_ms: null,
        model: null,
        completed_at: current.finished ? current.startedAt : null,
      });
    }
    current = null;
  };

  for (const envelope of envelopes) {
    const event = envelope.event;
    if (event.kind === 'prompt_started') {
      flush();
      const id = String(event.snapshot.id);
      turns.push({
        id: `u-${conversationId}-${id}`,
        role: 'user',
        blocks: [{ type: 'text', text: event.snapshot.text_preview }],
        timestamp: event.snapshot.created_at,
        usage: null,
        duration_ms: null,
        model: null,
        completed_at: null,
      });
      inProgressToolCallIds = new Set<string>();
      current = {
        promptId: id,
        blocks: [],
        resultIndexByToolId: new Map(),
        planIndex: -1,
        startedAt: event.snapshot.created_at,
        finished: finishedPromptIds.has(id),
      };
    } else if (current) {
      appendReplyEvent(current, event, inProgressToolCallIds);
    }
  }
  flush();

  return { turns, inProgressToolCallIds };
}

export function getTimelineTurns(
  input: GetTimelineTurnsInput
): ConversationTimelineTurn[] {
  const { conversationId, persisted, live, inProgressToolCallIds } = input;

  if (live.length === 0) {
    return persisted.map((turn, index) => ({
      key: `persisted-${conversationId}-${turn.id}-${index}`,
      turn,
      phase: 'persisted' as const,
    }));
  }

  const firstLiveTs = live[0]?.timestamp ?? '';
  const result: ConversationTimelineTurn[] = [];
  persisted
    .filter(
      (turn) => !!turn.timestamp && !!firstLiveTs && turn.timestamp < firstLiveTs
    )
    .forEach((turn, index) =>
      result.push({
        key: `persisted-${conversationId}-${turn.id}-${index}`,
        turn,
        phase: 'persisted',
      })
    );

  const lastIndex = live.length - 1;
  live.forEach((turn, index) => {
    const isInFlight =
      index === lastIndex &&
      turn.role === 'assistant' &&
      turn.completed_at == null;
    result.push({
      key: `live-${conversationId}-${turn.id}-${index}`,
      turn,
      phase: isInFlight ? 'streaming' : 'persisted',
      inProgressToolCallIds: isInFlight ? inProgressToolCallIds : undefined,
    });
  });

  return result;
}
