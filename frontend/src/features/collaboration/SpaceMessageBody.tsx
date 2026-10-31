import { useState } from 'react';
import { Check } from 'lucide-react';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { AgentQuestionCard } from '@/components/tasks/follow-up/AgentQuestionCard';
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  ConversationPermissionView,
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
import {
  reactionBadgeEmojis,
  type SpaceReaction,
} from './spaceReactions';
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
const HANDOFF_RE =
  /<handoff\b([^>]*)>([\s\S]*?)<\/handoff>/i;

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
  const body = [
    action,
    command ? `\`\`\`\n${command}\n\`\`\`` : '',
    reason,
  ]
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
  const match = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')
  );
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
    const answerText =
      typeof resolution.answer === 'string' ? resolution.answer.trim() : '';
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
    const labels = Array.isArray(answers)
      ? answers.flatMap((item) => {
          if (!item || typeof item !== 'object' || !('labels' in item)) {
            return [];
          }
          const raw = (item as { labels: unknown }).labels;
          return Array.isArray(raw)
            ? raw.filter((label): label is string => typeof label === 'string')
            : [];
        })
      : [];
    const summary = labels.join('；');
    await resolve(
      { answers, answer: summary },
      summary
        ? i18n.t('panels:ui.spaceMessage.answeredValue', { value: summary })
        : i18n.t('panels:ui.spaceMessage.handled')
    );
  };
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
  if (card.kind === 'ask' && card.questions && card.questions.length > 0) {
    return (
      <div
        className="collaboration-card-actions mt-2"
        data-testid="collaboration-card-actions"
      >
        <AgentQuestionCard
          request={{
            question_id: card.id,
            prompt: card.body,
            options: card.options,
            schema: {
              type: 'object',
              'x-vibex-questions': card.questions as unknown as JsonValue,
            },
          }}
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
  if (card.kind === 'approval') {
    return (
      <div
        className="collaboration-card-actions mt-2"
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
      className="collaboration-card-actions mt-2 flex flex-wrap items-center gap-2"
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

export function SpaceMessageBody({
  fromYou,
  text,
  workspacePath,
  workspaceId,
  deliveryStatus = null,
  deliveryTickTestId,
  reactions,
  cards,
}: {
  fromYou: boolean;
  text: string;
  workspacePath?: string;
  workspaceId?: string;
  deliveryStatus?: MessageDeliveryTickStatus;
  deliveryTickTestId?: string;
  reactions?: readonly SpaceReaction[] | null;
  cards?: readonly SpaceCardRecord[] | null;
}) {
  const memberMentionCtx = useCollaborationMemberMention();
  const effectiveMentionCtx = memberMentionCtx.enableMemberMentions
    ? memberMentionCtx
    : { ...memberMentionCtx, enableMemberMentions: true };
  const card = parseCard(text);
  const cardRecord =
    card && cards ? (cards.find((item) => item.id === card.id) ?? null) : null;
  const handoff = parseHandoff(text);
  if (fromYou) {
    const source = handoff ? handoffSurroundingText(handoff) : text;
    const { text: cleanText, images, files } = splitDisplayContentImages(source);
    const hasText =
      cleanText.trim().length > 0 ||
      Boolean(handoff) ||
      (images.length === 0 && files.length === 0);
    return (
      <CollaborationMemberMentionContext.Provider value={effectiveMentionCtx}>
        <div className="conv-entry-item conv-user-msg">
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
  return (
    <CollaborationMemberMentionContext.Provider value={effectiveMentionCtx}>
      <div className="conv-entry-item conv-assistant-msg collaboration-member-msg px-4 py-1.5 text-sm">
        <div className="collaboration-bubble-outer-row collaboration-bubble-outer-row--member">
          <div className="collaboration-bubble-shell">
            <div
              className="conv-assistant-body collaboration-member-bubble"
              data-testid="collaboration-member-bubble"
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
              {card ? (
                <SpaceCardActions card={card} cardRecord={cardRecord} />
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
}
