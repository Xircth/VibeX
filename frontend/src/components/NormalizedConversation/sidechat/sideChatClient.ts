import type { ContentBlock, MessageTurn } from 'shared/types';
import {
  formatQuoteToken,
  quoteTokenChipLabel,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import { backendCall, backendStream } from '@/lib/backendTransport';

export interface SideChatContextTurn {
  turnNumber: number;
  userText: string;
  assistantText: string;
}

export interface SideChatToolCall {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
}

export interface SideChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: SideChatToolCall[];
  isStreaming?: boolean;
  isError?: boolean;
}

export type SideChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; toolCall: SideChatToolCall }
  | { type: 'done'; content?: string }
  | { type: 'error'; message: string };

export interface SendSideChatPromptRequest {
  conversationId: string;
  sideChatId: string;
  prompt: string;
  contextTurns: SideChatContextTurn[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
  onEvent?: (event: SideChatStreamEvent) => void;
}

export interface SendSideChatPromptResult {
  content: string;
  toolCalls?: SideChatToolCall[];
}

export interface SideChatClient {
  sendSideChatPrompt(
    request: SendSideChatPromptRequest
  ): Promise<SendSideChatPromptResult>;
  abortSideChat(request: {
    conversationId: string;
    sideChatId: string;
  }): Promise<void>;
}

const MAX_CONTEXT_TURN_CHARS = 600;

function extractBlocksPlainText(blocks: ReadonlyArray<ContentBlock>): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join('\n\n').trim();
}

function truncateContextSnippet(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= MAX_CONTEXT_TURN_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_CONTEXT_TURN_CHARS)}…`;
}

function unwrapTurnItem(
  item: MessageTurn | { turn: MessageTurn }
): MessageTurn {
  return 'turn' in item ? item.turn : item;
}

/**
 * Extracts up to the last `maxTurns` user/assistant exchanges from the main
 * thread without mutating any timeline state.
 */
export function extractRecentMainThreadTurns(
  turns: ReadonlyArray<MessageTurn | { turn: MessageTurn }> | undefined,
  maxTurns = 3
): SideChatContextTurn[] {
  if (!turns || turns.length === 0 || maxTurns <= 0) {
    return [];
  }

  const grouped: Array<{ userText: string; assistantParts: string[] }> = [];

  for (const rawItem of turns) {
    const turn = unwrapTurnItem(rawItem);
    const text = extractBlocksPlainText(turn.blocks);
    if (!text) continue;

    if (turn.role === 'user') {
      grouped.push({ userText: text, assistantParts: [] });
    } else if (turn.role === 'assistant') {
      const current = grouped[grouped.length - 1];
      if (current) {
        current.assistantParts.push(text);
      } else {
        grouped.push({ userText: '', assistantParts: [text] });
      }
    }
  }

  const startIndex = Math.max(0, grouped.length - maxTurns);
  return grouped.slice(startIndex).map((entry, idx) => ({
    turnNumber: startIndex + idx + 1,
    userText: truncateContextSnippet(entry.userText),
    assistantText: truncateContextSnippet(entry.assistantParts.join('\n\n')),
  }));
}

export function buildSideChatConclusionQuote({
  userQuestion,
  assistantAnswer,
  prefixLabel = '[Side Chat Conclusion]',
  questionLabel = 'Question',
  answerLabel = 'Conclusion',
}: {
  userQuestion: string;
  assistantAnswer: string;
  prefixLabel?: string;
  questionLabel?: string;
  answerLabel?: string;
}): {
  summaryText: string;
  formattedToken: string;
  chipLabel: string;
} {
  const cleanQuestion = userQuestion.trim();
  const cleanAnswer = assistantAnswer.trim();
  const lines = [prefixLabel];
  if (cleanQuestion) {
    lines.push(`${questionLabel}: ${cleanQuestion}`);
  }
  if (cleanAnswer) {
    lines.push(`${answerLabel}: ${cleanAnswer}`);
  }
  const summaryText = lines.join('\n');
  return {
    summaryText,
    formattedToken: formatQuoteToken(summaryText),
    chipLabel: quoteTokenChipLabel(cleanAnswer || cleanQuestion || summaryText),
  };
}

function parseRawStreamPayload(raw: unknown): SideChatStreamEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const type = String(record.type ?? record.kind ?? '').toLowerCase();
  if (type === 'delta' || type === 'text_delta') {
    const text = typeof record.text === 'string' ? record.text : '';
    return { type: 'delta', text };
  }
  if (type === 'tool' || type === 'tool_call') {
    const tool = (record.toolCall ?? record.tool_call ?? record) as Record<
      string,
      unknown
    >;
    const rawStatus = String(tool.status ?? 'running').toLowerCase();
    const status: SideChatToolCall['status'] =
      rawStatus === 'completed' || rawStatus === 'done'
        ? 'completed'
        : rawStatus === 'failed' || rawStatus === 'error'
          ? 'failed'
          : 'running';
    return {
      type: 'tool',
      toolCall: {
        id: String(tool.id ?? tool.call_id ?? 'tool-call'),
        name: String(tool.name ?? tool.tool_name ?? 'tool'),
        status,
        summary:
          typeof tool.summary === 'string'
            ? tool.summary
            : typeof tool.title === 'string'
              ? tool.title
              : undefined,
      },
    };
  }
  if (type === 'error') {
    return {
      type: 'error',
      message: String(record.message ?? record.error ?? 'Side Chat failed'),
    };
  }
  if (type === 'done' || type === 'completed') {
    return {
      type: 'done',
      content: typeof record.content === 'string' ? record.content : undefined,
    };
  }
  return null;
}

export function createSideChatClient(): SideChatClient {
  return {
    async sendSideChatPrompt(
      request: SendSideChatPromptRequest
    ): Promise<SendSideChatPromptResult> {
      const {
        conversationId,
        sideChatId,
        prompt,
        contextTurns,
        history,
        signal,
        onEvent,
      } = request;

      const payload = {
        conversationId,
        sideChatId,
        prompt,
        contextTurns,
        history,
        sideChat: true,
      };

      try {
        const result = await backendStream<unknown>(
          'conversation_side_chat_send',
          { request: payload },
          (message) => {
            if (signal?.aborted) return;
            const parsed = parseRawStreamPayload(message);
            if (parsed) {
              onEvent?.(parsed);
            }
          }
        );

        if (typeof result === 'string') {
          return { content: result };
        }
        if (result && typeof result === 'object') {
          const rec = result as Record<string, unknown>;
          const content =
            typeof rec.content === 'string'
              ? rec.content
              : typeof rec.answer === 'string'
                ? rec.answer
                : '';
          const toolCalls = Array.isArray(rec.toolCalls)
            ? (rec.toolCalls as SideChatToolCall[])
            : undefined;
          return { content, toolCalls };
        }
        return { content: '' };
      } catch (ipcError) {
        const msg =
          ipcError instanceof Error ? ipcError.message : String(ipcError);
        const shouldTryHttpFallback =
          typeof fetch === 'function' &&
          /unknown\s+command|not\s*found|unimplemented/i.test(msg);

        if (!shouldTryHttpFallback) {
          throw ipcError;
        }

        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/side-chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal,
          }
        );

        if (!response.ok) {
          throw new Error(
            `Side Chat HTTP ${response.status}: ${response.statusText}`
          );
        }

        const json = (await response.json()) as Record<string, unknown>;
        return {
          content:
            typeof json.content === 'string'
              ? json.content
              : typeof json.answer === 'string'
                ? json.answer
                : '',
          toolCalls: Array.isArray(json.toolCalls)
            ? (json.toolCalls as SideChatToolCall[])
            : undefined,
        };
      }
    },

    async abortSideChat({
      conversationId,
      sideChatId,
    }: {
      conversationId: string;
      sideChatId: string;
    }): Promise<void> {
      try {
        await backendCall('conversation_side_chat_abort', {
          request: { conversationId, sideChatId },
        });
      } catch {
        // Ephemeral session abort is best-effort.
      }
    },
  };
}

export const defaultSideChatClient: SideChatClient = createSideChatClient();
