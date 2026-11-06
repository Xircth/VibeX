import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { AgentQuestionCard } from '@/components/tasks/follow-up/AgentQuestionCard';
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { HtmlPreviewBlock } from '@/components/NormalizedConversation/HtmlPreviewBlock';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { AskQuestionToolCard } from '@/components/NormalizedConversation/tools/AskQuestionToolCard';
import { splitMessageHtmlSegments } from '@/lib/conversation-rendering/splitMessageHtmlBlocks';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  ConversationPermissionView,
  ConversationQuestionResponse,
  JsonValue,
} from 'shared/types';
import {
  CollaborationMemberMentionContext,
  useCollaborationMemberMention,
} from './MemberMentionChip';
import { UserMessageAttachments } from '@/components/NormalizedConversation/UserMessageImageAttachment';
import { UserMessageMarkdown } from '@/components/NormalizedConversation/UserMessageMarkdown';
import { splitDisplayContentImages } from '@/components/NormalizedConversation/userMessageImages';

import { collaborationCall } from './collaborationApi';
import type { SpaceCardRecord } from './space/types';
import { reactionBadgeEmojis, type SpaceReaction } from './spaceReactions';
import i18n from '@/i18n';

export type ParsedCard = {
  kind: 'ask' | 'approval';
  id: string;
  before: string;
  body: string;
  options: string[];
  questions?: unknown[];
  action?: string;
  command?: string;
  reason?: string;
};

const CARD_RE = /<card kind="(ask|approval)" id="([^"]+)">([\s\S]*?)<\/card>/;
const HANDOFF_RE = /<handoff\b([^>]*)>([\s\S]*?)<\/handoff>/i;

function unescapeCard(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function cardField(inner: string, tag: string): string {
  const match = inner.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeCard(match[1].trim()) : '';
}

/** Parse an agent ask/approval card (rendered by the backend) out of a message. */
export function parseCard(text: string): ParsedCard | null {
  const match = text.match(CARD_RE);
  if (!match) return null;
  const kind = match[1] as ParsedCard['kind'];
  const inner = match[3];
  const before = text.slice(0, match.index).trim();
  if (kind === 'ask') {
    const options = cardField(inner, 'options')
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
    const questionsRaw = cardField(inner, 'questions');
    let questions: unknown[] | undefined;
    if (questionsRaw) {
      try {
        const parsed = JSON.parse(questionsRaw) as unknown;
        if (Array.isArray(parsed)) questions = parsed;
      } catch {
        questions = undefined;
      }
    }
    return {
      kind,
      id: match[2],
      before,
      body: cardField(inner, 'question'),
      options,
      questions,
    };
  }
  const action = cardField(inner, 'action');
  const command = cardField(inner, 'command');
  const reason = cardField(inner, 'reason');
  const body = [action, command ? `\`\`\`\n${command}\n\`\`\`` : '', reason]
    .filter(Boolean)
    .join('\n\n');
  return {
    kind,
    id: match[2],
    before,
    body,
    options: [],
    action,
    command,
    reason,
  };
}

export function approvalCardToPermissionView(
  card: Pick<ParsedCard, 'id' | 'action' | 'command' | 'reason' | 'body'>,
  status: 'pending' | 'responded' = 'pending'
): ConversationPermissionView {
  const action = (card.action ?? card.body ?? '').trim();
  const command = (card.command ?? '').trim();
  const reason = (card.reason ?? '').trim();
  const content: Array<{ text: string }> = [];
  if (command && reason) {
    content.push({ text: command }, { text: reason });
  } else if (reason) {
    content.push({ text: reason });
  }
  const rawInput = command
    ? { command, ...(reason ? { description: reason } : {}) }
    : reason
      ? { description: reason }
      : {};
  return {
    permission_id: card.id,
    title: action,
    details: {
      fields: {
        kind: command ? 'execute' : 'tool',
        title: action,
        rawInput,
        content,
      },
    } as unknown as JsonValue,
    options: [
      {
        id: 'allow_once',
        label: i18n.t('conversation:permissionRequestCard.allowOnce'),
        kind: 'allow_once',
        description: null,
      },
      {
        id: 'allow_always',
        label: i18n.t('conversation:permissionRequestCard.allowAlways'),
        kind: 'allow_always',
        description: null,
      },
      {
        id: 'deny',
        label: i18n.t('conversation:permissionRequestCard.reject'),
        kind: 'reject_once',
        description: null,
      },
    ],
    status,
  };
}

export function mapPermissionResponseToApprovalDecision(
  response: AgentPermissionResponse
): 'allow_once' | 'allow_always' | 'deny' {
  if (response.kind === 'selected') {
    if (response.persist || response.option_id === 'allow_always') {
      return 'allow_always';
    }
    if (
      response.option_id === 'allow_once' ||
      response.option_id.startsWith('allow')
    ) {
      return 'allow_once';
    }
  }
  return 'deny';
}

export type ParsedHandoff = {
  id: string;
  depth: string;
  done: string;
  inputsConstraints: string;
  ask: string;
  before: string;
  after: string;
};

function handoffAttr(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match ? unescapeCard(match[1].trim()) : '';
}

/** Parse a legacy `<handoff>` envelope so the bubble does not show raw XML. */
export function parseHandoff(text: string): ParsedHandoff | null {
  const match = text.match(HANDOFF_RE);
  if (!match) return null;
  const attrs = match[1] ?? '';
  const inner = match[2] ?? '';
  const start = match.index ?? 0;
  return {
    id: handoffAttr(attrs, 'id'),
    depth: handoffAttr(attrs, 'depth'),
    done: cardField(inner, 'done'),
    inputsConstraints: cardField(inner, 'inputs_constraints'),
    ask: cardField(inner, 'ask'),
    before: text.slice(0, start).trim(),
    after: text.slice(start + match[0].length).trim(),
  };
}

function handoffSurroundingText(handoff: ParsedHandoff): string {
  return [handoff.before, handoff.after].filter(Boolean).join('\n\n');
}

/** One-line sidebar preview: cards become a short label instead of raw markup. */
export function messagePreviewText(text: string): string {
  const card = parseCard(text);
  let result = text;
  if (card) {
    const label =
      card.kind === 'approval'
        ? i18n.t('panels:ui.spaceMessage.approvalRequest')
        : card.body
          ? i18n.t('panels:ui.spaceMessage.questionBody', { body: card.body })
          : i18n.t('panels:ui.spaceMessage.question');
    result = label;
  } else {
    const handoff = parseHandoff(text);
    if (handoff) {
      const ask = handoff.ask.replace(/\s+/g, ' ').trim();
      result = ask
        ? i18n.t('panels:ui.spaceMessage.handoffAsk', { ask })
        : i18n.t('panels:ui.spaceMessage.handoff');
    } else {
      result = text
        .replace(
          /<card[\s\S]*?(<\/card>|$)/g,
          i18n.t('panels:ui.spaceMessage.approvalRequest')
        )
        .replace(
          /<handoff[\s\S]*?(<\/handoff>|$)/gi,
          i18n.t('panels:ui.spaceMessage.handoff')
        );
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

function extractAnswerItemLabels(item: unknown): string[] {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const nested = extractReadableAnswerLabels(parsed);
        if (nested.length > 0) return nested;
      } catch {
        // Keep raw text when not valid JSON.
      }
    }
    return [trimmed];
  }
  if (!item || typeof item !== 'object') return [];
  const obj = item as Record<string, unknown>;
  for (const key of ['labels', 'selected'] as const) {
    if (Array.isArray(obj[key])) {
      const labels = (obj[key] as unknown[])
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean);
      if (labels.length > 0) return labels;
    }
  }
  for (const key of ['label', 'answer', 'value'] as const) {
    if (typeof obj[key] === 'string' && (obj[key] as string).trim()) {
      return [(obj[key] as string).trim()];
    }
  }
  return [];
}

function extractReadableAnswerLabels(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap(extractAnswerItemLabels);
  }
  if (raw && typeof raw === 'object' && 'answers' in raw) {
    return extractReadableAnswerLabels((raw as { answers: unknown }).answers);
  }
  return extractAnswerItemLabels(raw);
}

function formatResolutionAnswerText(
  resolution: Record<string, unknown> | null | undefined
): string {
  if (!resolution || typeof resolution !== 'object') return '';
  const fromAnswers = extractReadableAnswerLabels(resolution.answers);
  if (fromAnswers.length > 0) return fromAnswers.join('；');
  const fromAnswer = extractReadableAnswerLabels(resolution.answer);
  if (fromAnswer.length > 0) return fromAnswer.join('；');
  return typeof resolution.answer === 'string' ? resolution.answer.trim() : '';
}

function resolvedQuestionResponse(
  cardRecord: SpaceCardRecord | null | undefined,
  localAnswers: unknown,
  localSummary: string
): ConversationQuestionResponse {
  const resolution =
    cardRecord?.resolution && typeof cardRecord.resolution === 'object'
      ? (cardRecord.resolution as Record<string, unknown>)
      : null;
  const answer = localSummary || formatResolutionAnswerText(resolution);
  const rawAnswers = localAnswers ?? resolution?.answers;
  const content: JsonValue | null = Array.isArray(rawAnswers)
    ? ({ answers: rawAnswers } as unknown as JsonValue)
    : null;
  return {
    answer,
    content,
  };
}

function resolvedCardLabel(
  cardRecord: SpaceCardRecord | null | undefined
): string | null {
  if (!cardRecord || !cardRecord.status || cardRecord.status === 'pending') {
    return null;
  }
  const resolution = cardRecord.resolution;
  if (resolution && typeof resolution === 'object') {
    const decision =
      typeof resolution.decision === 'string' ? resolution.decision.trim() : '';
    if (decision) {
      return decision === 'deny'
        ? i18n.t('panels:ui.spaceMessage.rejected')
        : i18n.t('panels:ui.spaceMessage.approved');
    }
    const answerText = formatResolutionAnswerText(
      resolution as Record<string, unknown>
    );
    if (answerText) {
      return i18n.t('panels:ui.spaceMessage.answeredValue', {
        value: answerText,
      });
    }
  }
  return i18n.t('panels:ui.spaceMessage.handled');
}

export function SpaceCardActions({
  card,
  cardRecord = null,
}: {
  card: ParsedCard;
  cardRecord?: SpaceCardRecord | null;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [localAnswers, setLocalAnswers] = useState<unknown>(null);
  const [localSummary, setLocalSummary] = useState('');
  const [error, setError] = useState('');
  const resolvedText = done ?? resolvedCardLabel(cardRecord);
  const resolve = async (input: Record<string, unknown>, label: string) => {
    setBusy(true);
    setError('');
    try {
      await collaborationCall('collaboration', 'card.resolve', {
        cardId: card.id,
        ...input,
      });
      setDone(label);
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      if (/already|resolved/i.test(message))
        setDone(i18n.t('panels:ui.spaceMessage.handled'));
      else setError(message);
    } finally {
      setBusy(false);
    }
  };
  const respondQuestion = async (response: AgentElicitationResponse) => {
    if (response.action === 'decline' || response.action === 'cancel') {
      await resolve(
        { declined: true },
        i18n.t('panels:ui.spaceMessage.handled')
      );
      return;
    }
    const content = response.content;
    const answers =
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      'answers' in content
        ? (content as { answers: unknown }).answers
        : content;
    const labels = extractReadableAnswerLabels(answers);
    const summary = labels.join('；');
    setLocalAnswers(answers);
    setLocalSummary(summary);
    await resolve(
      { answers, answer: summary },
      summary
        ? i18n.t('panels:ui.spaceMessage.answeredValue', { value: summary })
        : i18n.t('panels:ui.spaceMessage.handled')
    );
  };
  if (card.kind === 'ask' && card.questions && card.questions.length > 0) {
    const request = {
      question_id: card.id,
      prompt: card.body,
      options: card.options,
      schema: {
        type: 'object',
        'x-vibex-questions': card.questions as unknown as JsonValue,
      },
    };
    if (resolvedText) {
      return (
        <div
          className="collaboration-card-actions space-y-1.5"
          data-testid="collaboration-card-actions"
        >
          <AskQuestionToolCard
            request={request}
            response={resolvedQuestionResponse(
              cardRecord,
              localAnswers,
              localSummary
            )}
          />
          <p
            className="collaboration-card-resolved text-xs text-muted-foreground"
            data-testid="collaboration-card-resolved"
          >
            {resolvedText}
          </p>
        </div>
      );
    }
    return (
      <div
        className="collaboration-card-actions"
        data-testid="collaboration-card-actions"
      >
        <AgentQuestionCard
          request={request}
          responding={busy}
          onRespond={(_questionId, response) => {
            void respondQuestion(response);
          }}
        />
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : null}
      </div>
    );
  }
  if (resolvedText) {
    return (
      <p
        className="collaboration-card-resolved text-xs text-muted-foreground"
        data-testid="collaboration-card-resolved"
      >
        {resolvedText}
      </p>
    );
  }
  if (card.kind === 'approval') {
    return (
      <div
        className="collaboration-card-actions"
        data-testid="collaboration-card-actions"
      >
        <PermissionRequestCard
          request={approvalCardToPermissionView(card)}
          responding={busy}
          onRespond={(_permissionId, response) => {
            const decision = mapPermissionResponseToApprovalDecision(response);
            void resolve(
              { decision },
              decision === 'deny'
                ? i18n.t('panels:ui.spaceMessage.rejected')
                : i18n.t('panels:ui.spaceMessage.approved')
            );
          }}
        />
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : null}
      </div>
    );
  }
  return (
    <div
      className="collaboration-card-actions flex flex-wrap items-center gap-2"
      data-testid="collaboration-card-actions"
    >
      {card.options.map((option) => (
        <Button
          key={option}
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void resolve(
              { answer: option },
              i18n.t('panels:ui.spaceMessage.answeredOption', {
                option: option,
              })
            )
          }
        >
          {option}
        </Button>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim())
            void resolve(
              { answer: answer.trim() },
              i18n.t('panels:ui.spaceMessage.answeredValue', {
                value: answer.trim(),
              })
            );
        }}
      >
        <Input
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder={i18n.t('panels:ui.spaceMessage.typeAnAnswer')}
          aria-label={i18n.t('panels:ui.spaceMessage.answer')}
          className="h-8 w-56"
          disabled={busy}
        />
        <Button type="submit" size="sm" disabled={busy || !answer.trim()}>
          {i18n.t('panels:ui.spaceMessage.answer')}
        </Button>
      </form>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export function bubbleText(envelope: {
  content?: string;
  summary?: string;
}): string {
  const content = String(envelope.content ?? '');
  if (content) {
    return content;
  }
  return String(envelope.summary ?? '');
}

export type MessageDeliveryTickStatus = 'sent' | 'delivered' | null;

export function MessageDeliveryTicks({
  status,
  testId,
}: {
  status: MessageDeliveryTickStatus;
  testId?: string;
}) {
  if (!status) return null;
  const isDelivered = status === 'delivered';
  return (
    <span
      className={`collaboration-message-ticks collaboration-message-status-ticks ${isDelivered ? 'is-delivered' : 'is-sent'}`}
      data-testid={testId ?? 'collaboration-message-ticks'}
      data-status={isDelivered ? 'claimed' : 'queued'}
      aria-label={isDelivered ? '已送达' : '已发送'}
      title={isDelivered ? '已送达' : '已发送'}
    >
      <Check
        size={11}
        width={11}
        height={11}
        strokeWidth={2.4}
        className="collaboration-message-tick collaboration-tick-icon collaboration-tick-first"
        aria-hidden="true"
      />
      {isDelivered ? (
        <Check
          size={11}
          width={11}
          height={11}
          strokeWidth={2.4}
          className="collaboration-message-tick collaboration-message-tick--second collaboration-tick-icon collaboration-tick-second"
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

export function SpaceMessageReactionBadge({
  reactions,
}: {
  reactions?: readonly SpaceReaction[] | null;
}) {
  const emojis = reactionBadgeEmojis(reactions ?? []);
  if (emojis.length === 0) return null;
  return (
    <span
      className="collaboration-bubble-reaction"
      data-testid="collaboration-bubble-reaction"
    >
      {emojis.join('')}
    </span>
  );
}

function SpaceHandoffCard({
  handoff,
  workspacePath,
}: {
  handoff: ParsedHandoff;
  workspacePath?: string;
}) {
  return (
    <div className="collaboration-handoff" data-testid="collaboration-handoff">
      <p className="collaboration-handoff-label">
        {i18n.t('panels:ui.spaceMessage.handoff')}
      </p>
      {handoff.done ? (
        <section className="collaboration-handoff-section">
          <h3 className="collaboration-handoff-section-label">
            {i18n.t('panels:ui.spaceMessage.handoffDone')}
          </h3>
          <AstryxMarkdown value={handoff.done} workspacePath={workspacePath} />
        </section>
      ) : null}
      {handoff.inputsConstraints ? (
        <section className="collaboration-handoff-section">
          <h3 className="collaboration-handoff-section-label">
            {i18n.t('panels:ui.spaceMessage.handoffConstraints')}
          </h3>
          <AstryxMarkdown
            value={handoff.inputsConstraints}
            workspacePath={workspacePath}
          />
        </section>
      ) : null}
      {handoff.ask ? (
        <section className="collaboration-handoff-section collaboration-handoff-ask">
          <h3 className="collaboration-handoff-section-label">
            {i18n.t('panels:ui.spaceMessage.handoffAskLabel')}
          </h3>
          <AstryxMarkdown value={handoff.ask} workspacePath={workspacePath} />
        </section>
      ) : null}
    </div>
  );
}

export const SPACE_MESSAGE_MAX_HEIGHT_PX = 240;
export const SPACE_MESSAGE_OVERFLOW_LINE_THRESHOLD = 10;
export const SPACE_MESSAGE_OVERFLOW_CHAR_THRESHOLD = 420;

export function estimateSpaceMessageOverflows(text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return false;
  if (normalized.length > SPACE_MESSAGE_OVERFLOW_CHAR_THRESHOLD) {
    return true;
  }
  return normalized.split('\n').length > SPACE_MESSAGE_OVERFLOW_LINE_THRESHOLD;
}

function CollapsibleSpaceBubbleContent({
  measureText,
  streaming = false,
  children,
}: {
  measureText: string;
  streaming?: boolean;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const wasStreamingRef = useRef(Boolean(streaming));
  const [needsCollapse, setNeedsCollapse] = useState(() =>
    estimateSpaceMessageOverflows(measureText)
  );

  useLayoutEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      setIsExpanded(false);
    }
    wasStreamingRef.current = Boolean(streaming);
  }, [streaming]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const check = () => {
      if (element.scrollHeight > 0 || element.clientHeight > 0) {
        setNeedsCollapse(element.scrollHeight > SPACE_MESSAGE_MAX_HEIGHT_PX);
      } else {
        setNeedsCollapse(estimateSpaceMessageOverflows(measureText));
      }
    };

    check();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      check();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [measureText]);

  const isCollapsed = !streaming && needsCollapse && !isExpanded;
  const expandLabel = i18n.t('panels:ui.spaceMessage.expandAll', '展开全部');
  const collapseLabel = i18n.t(
    'panels:ui.spaceMessage.collapseAll',
    '收起全部'
  );

  return (
    <div
      className="collaboration-bubble-collapsible"
      data-collapsed={isCollapsed ? 'true' : 'false'}
      data-testid="collaboration-bubble-collapsible"
    >
      <div
        ref={contentRef}
        className="collaboration-bubble-collapsible-body"
        data-testid="collaboration-bubble-collapsible-body"
      >
        {children}
      </div>
      {isCollapsed ? (
        <div
          className="collaboration-bubble-collapsible-fade"
          data-testid="collaboration-bubble-collapsible-fade"
        >
          <button
            type="button"
            className="collaboration-bubble-expand-pill"
            data-testid="collaboration-bubble-expand-pill"
            aria-label={expandLabel}
            onClick={(event) => {
              event.stopPropagation();
              setIsExpanded(true);
            }}
          >
            <span>{expandLabel}</span>
            <ChevronDown
              className="collaboration-bubble-expand-pill-icon"
              aria-hidden="true"
            />
          </button>
        </div>
      ) : !streaming && needsCollapse && isExpanded ? (
        <div
          className="collaboration-bubble-collapsible-footer"
          data-testid="collaboration-bubble-collapsible-footer"
        >
          <button
            type="button"
            className="collaboration-bubble-expand-pill collaboration-bubble-collapse-pill"
            data-testid="collaboration-bubble-collapse-pill"
            aria-label={collapseLabel}
            onClick={(event) => {
              event.stopPropagation();
              setIsExpanded(false);
            }}
          >
            <span>{collapseLabel}</span>
            <ChevronUp
              className="collaboration-bubble-expand-pill-icon"
              aria-hidden="true"
            />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export const SpaceMessageBody = memo(function SpaceMessageBody({
  fromYou,
  text,
  workspacePath,
  workspaceId,
  deliveryStatus = null,
  deliveryTickTestId,
  reactions,
  cards,
  streaming = false,
}: {
  fromYou: boolean;
  text: string;
  workspacePath?: string;
  workspaceId?: string;
  deliveryStatus?: MessageDeliveryTickStatus;
  deliveryTickTestId?: string;
  reactions?: readonly SpaceReaction[] | null;
  cards?: readonly SpaceCardRecord[] | null;
  streaming?: boolean;
}) {
  const memberMentionCtx = useCollaborationMemberMention();
  const effectiveMentionCtx = useMemo(
    () =>
      memberMentionCtx.enableMemberMentions
        ? memberMentionCtx
        : { ...memberMentionCtx, enableMemberMentions: true },
    [memberMentionCtx]
  );
  const card = useMemo(() => parseCard(text), [text]);
  const cardRecord =
    card && cards ? (cards.find((item) => item.id === card.id) ?? null) : null;
  const handoff = useMemo(() => parseHandoff(text), [text]);
  if (fromYou) {
    const source = handoff ? handoffSurroundingText(handoff) : text;
    const {
      text: cleanText,
      images,
      files,
    } = splitDisplayContentImages(source);
    const hasText =
      cleanText.trim().length > 0 ||
      Boolean(handoff) ||
      (images.length === 0 && files.length === 0);
    return (
      <CollaborationMemberMentionContext.Provider value={effectiveMentionCtx}>
        <div className="conv-entry-item conv-user-msg flex flex-col items-end gap-1.5">
          {images.length > 0 || files.length > 0 ? (
            <UserMessageAttachments
              images={images}
              files={files}
              taskAttemptId={workspaceId}
              workspacePath={workspacePath}
            />
          ) : null}
          {hasText ? (
            <ChatMessage
              sender="user"
              density="compact"
              className="vibex-user-message"
            >
              <div className="collaboration-bubble-outer-row collaboration-bubble-outer-row--user">
                <div className="collaboration-bubble-shell">
                  <ChatMessageBubble className="conv-user-bubble">
                    <CollapsibleSpaceBubbleContent
                      measureText={source}
                      streaming={streaming}
                    >
                      {cleanText.trim() ? (
                        <UserMessageMarkdown
                          value={cleanText}
                          workspacePath={workspacePath}
                        />
                      ) : null}
                      {handoff ? (
                        <SpaceHandoffCard
                          handoff={handoff}
                          workspacePath={workspacePath}
                        />
                      ) : null}
                    </CollapsibleSpaceBubbleContent>
                  </ChatMessageBubble>
                  <SpaceMessageReactionBadge reactions={reactions} />
                </div>
                <MessageDeliveryTicks
                  status={deliveryStatus}
                  testId={deliveryTickTestId}
                />
              </div>
            </ChatMessage>
          ) : deliveryStatus ? (
            <div className="flex justify-end px-4">
              <MessageDeliveryTicks
                status={deliveryStatus}
                testId={deliveryTickTestId}
              />
            </div>
          ) : null}
        </div>
      </CollaborationMemberMentionContext.Provider>
    );
  }
  const markdownValue = card
    ? [
        card.before,
        (card.questions && card.questions.length > 0) ||
        card.kind === 'approval'
          ? ''
          : card.body,
      ]
        .filter(Boolean)
        .join('\n\n')
    : handoff
      ? handoffSurroundingText(handoff)
      : text;
  const segments = markdownValue
    ? splitMessageHtmlSegments(markdownValue, { workspacePath })
    : [];
  const hasHtmlSegment = segments.some((seg) => seg.kind === 'html');
  const isStandaloneQuestionCard = Boolean(
    card?.kind === 'ask' && card.questions && card.questions.length > 0
  );
  const inlineCard = card && !isStandaloneQuestionCard ? card : null;
  const standaloneQuestionCardNode =
    isStandaloneQuestionCard && card ? (
      <div
        className="conv-entry-item collaboration-member-msg collaboration-question-card-msg text-sm"
        data-testid="collaboration-question-card-container"
      >
        <div className="collaboration-bubble-outer-row collaboration-bubble-outer-row--member">
          <div className="collaboration-bubble-shell">
            <SpaceCardActions card={card} cardRecord={cardRecord} />
            <SpaceMessageReactionBadge reactions={reactions} />
          </div>
          <MessageDeliveryTicks
            status={deliveryStatus}
            testId={deliveryTickTestId}
          />
        </div>
      </div>
    ) : null;

  if (hasHtmlSegment) {
    let firstMarkdownSeen = false;
    return (
      <CollaborationMemberMentionContext.Provider value={effectiveMentionCtx}>
        <div
          className="collaboration-split-message-blocks"
          data-testid="collaboration-split-message-blocks"
        >
          {segments.map((seg, idx) => {
            const isLast = idx === segments.length - 1;
            const showTailMeta = isLast && !isStandaloneQuestionCard;
            if (seg.kind === 'html') {
              return (
                <div
                  key={`seg-html-${idx}`}
                  className="collaboration-standalone-html-block px-4 py-1 text-sm"
                  data-testid="collaboration-standalone-html-block"
                >
                  <HtmlPreviewBlock
                    code={seg.code}
                    filePath={seg.filePath}
                    displayPath={seg.displayPath}
                    title={seg.title}
                    workspacePath={workspacePath}
                    standalone
                  />
                  {isLast &&
                  (handoff ||
                    inlineCard ||
                    (showTailMeta && (reactions?.length || deliveryStatus))) ? (
                    <div className="collaboration-bubble-outer-row collaboration-bubble-outer-row--member mt-1">
                      <div className="collaboration-bubble-shell">
                        {handoff ? (
                          <SpaceHandoffCard
                            handoff={handoff}
                            workspacePath={workspacePath}
                          />
                        ) : null}
                        {inlineCard ? (
                          <SpaceCardActions
                            card={inlineCard}
                            cardRecord={cardRecord}
                          />
                        ) : null}
                        {showTailMeta ? (
                          <SpaceMessageReactionBadge reactions={reactions} />
                        ) : null}
                      </div>
                      {showTailMeta ? (
                        <MessageDeliveryTicks
                          status={deliveryStatus}
                          testId={deliveryTickTestId}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            }

            const bubbleTestId = !firstMarkdownSeen
              ? 'collaboration-member-bubble'
              : `collaboration-member-bubble-${idx}`;
            firstMarkdownSeen = true;
            return (
              <div
                key={`seg-md-${idx}`}
                className="conv-entry-item conv-assistant-msg collaboration-member-msg px-4 py-1.5 text-sm"
              >
                <div className="collaboration-bubble-outer-row collaboration-bubble-outer-row--member">
                  <div className="collaboration-bubble-shell">
                    <div
                      className="conv-assistant-body collaboration-member-bubble"
                      data-testid={bubbleTestId}
                    >
                      <CollapsibleSpaceBubbleContent
                        measureText={seg.text}
                        streaming={streaming}
                      >
                        <AstryxMarkdown
                          value={seg.text}
                          workspacePath={workspacePath}
                        />
                        {isLast && handoff ? (
                          <SpaceHandoffCard
                            handoff={handoff}
                            workspacePath={workspacePath}
                          />
                        ) : null}
                      </CollapsibleSpaceBubbleContent>
                      {isLast && inlineCard ? (
                        <SpaceCardActions
                          card={inlineCard}
                          cardRecord={cardRecord}
                        />
                      ) : null}
                    </div>
                    {showTailMeta ? (
                      <SpaceMessageReactionBadge reactions={reactions} />
                    ) : null}
                  </div>
                  {showTailMeta ? (
                    <MessageDeliveryTicks
                      status={deliveryStatus}
                      testId={deliveryTickTestId}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
          {standaloneQuestionCardNode}
        </div>
      </CollaborationMemberMentionContext.Provider>
    );
  }

  const hasMemberProse = Boolean(markdownValue) || Boolean(handoff);
  if (isStandaloneQuestionCard) {
    return (
      <CollaborationMemberMentionContext.Provider value={effectiveMentionCtx}>
        {hasMemberProse ? (
          <div
            className="collaboration-split-message-blocks"
            data-testid="collaboration-split-message-blocks"
          >
            <div className="conv-entry-item conv-assistant-msg collaboration-member-msg px-4 py-1.5 text-sm">
              <div className="collaboration-bubble-outer-row collaboration-bubble-outer-row--member">
                <div className="collaboration-bubble-shell">
                  <div
                    className="conv-assistant-body collaboration-member-bubble"
                    data-testid="collaboration-member-bubble"
                  >
                    <CollapsibleSpaceBubbleContent
                      measureText={handoff ? text : markdownValue}
                      streaming={streaming}
                    >
                      {markdownValue ? (
                        <AstryxMarkdown
                          value={markdownValue}
                          workspacePath={workspacePath}
                        />
                      ) : null}
                      {handoff ? (
                        <SpaceHandoffCard
                          handoff={handoff}
                          workspacePath={workspacePath}
                        />
                      ) : null}
                    </CollapsibleSpaceBubbleContent>
                  </div>
                </div>
              </div>
            </div>
            {standaloneQuestionCardNode}
          </div>
        ) : (
          standaloneQuestionCardNode
        )}
      </CollaborationMemberMentionContext.Provider>
    );
  }

  return (
    <CollaborationMemberMentionContext.Provider value={effectiveMentionCtx}>
      <div className="conv-entry-item conv-assistant-msg collaboration-member-msg px-4 py-1.5 text-sm">
        <div className="collaboration-bubble-outer-row collaboration-bubble-outer-row--member">
          <div className="collaboration-bubble-shell">
            <div
              className="conv-assistant-body collaboration-member-bubble"
              data-testid="collaboration-member-bubble"
            >
              {hasMemberProse ? (
                <CollapsibleSpaceBubbleContent
                  measureText={handoff ? text : markdownValue}
                  streaming={streaming}
                >
                  {markdownValue ? (
                    <AstryxMarkdown
                      value={markdownValue}
                      workspacePath={workspacePath}
                    />
                  ) : null}
                  {handoff ? (
                    <SpaceHandoffCard
                      handoff={handoff}
                      workspacePath={workspacePath}
                    />
                  ) : null}
                </CollapsibleSpaceBubbleContent>
              ) : null}
              {inlineCard ? (
                <SpaceCardActions card={inlineCard} cardRecord={cardRecord} />
              ) : null}
            </div>
            <SpaceMessageReactionBadge reactions={reactions} />
          </div>
          <MessageDeliveryTicks
            status={deliveryStatus}
            testId={deliveryTickTestId}
          />
        </div>
      </div>
    </CollaborationMemberMentionContext.Provider>
  );
});
