import { useMemo, useRef, useState, type ReactNode } from 'react';
import { BellRing, ChevronDown, ChevronRight, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { SpaceMessageBody, bubbleText } from './SpaceMessageBody';
import {
  ApprovalCard,
  AskCard,
  HandoffCard,
  ReceiptRow,
  WorktreeConflictCard,
  type CardResolution,
} from './ThreadCards';
import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import {
  THREAD_COPY,
  mentionConsequence,
  parseCard,
  parseHandoff,
  parseWorktreeConflict,
  receiptState,
  segmentStream,
  type PresenceView,
  type ReceiptInput,
  type StreamMessage,
} from './threadModel';

export type GroupMessage = StreamMessage & {
  receipts?: ReceiptInput[];
};

export type GroupSeat = {
  memberId: string;
  nickname: string;
  conversationId: string | null;
  avatar: MemberBotAvatarConfig;
  presence: PresenceView;
  /** Busy in a thread other than this group. */
  busyElsewhere: string | null;
};

export function authorOf(actor: string | undefined): {
  you: boolean;
  nickname: string;
} {
  const raw = String(actor ?? '');
  if (raw.endsWith('/user')) return { you: true, nickname: THREAD_COPY.you };
  const marker = '/member/';
  const index = raw.lastIndexOf(marker);
  if (index < 0) return { you: false, nickname: raw || '?' };
  try {
    return {
      you: false,
      nickname: decodeURIComponent(raw.slice(index + marker.length)),
    };
  } catch {
    return { you: false, nickname: raw.slice(index + marker.length) };
  }
}

/** `@昵称` tokens in a draft that match seat nicknames. */
export function extractMentions(
  text: string,
  nicknames: readonly string[]
): string[] {
  const found = new Set<string>();
  const sorted = [...nicknames].sort((a, b) => b.length - a.length);
  for (const match of text.matchAll(/@(\S+)/g)) {
    const token = match[1];
    const hit = sorted.find((name) => token.startsWith(name));
    if (hit) found.add(hit);
  }
  return Array.from(found);
}

function MemberBar({ seats }: { seats: readonly GroupSeat[] }) {
  return (
    <div className="collab-member-bar" data-testid="collab-member-bar">
      {seats.map((seat) => (
        <span
          key={seat.memberId}
          className="collaboration-top-member-chip"
          title={seat.presence.line ?? THREAD_COPY.idle}
        >
          <span className="collab-chip-dot">
            <MemberBotAvatar
              config={seat.avatar}
              animated={false}
              className="h-4 w-4"
            />
            <span
              className={cn(
                'workspace-session-status',
                `workspace-session-status--${seat.presence.state}`
              )}
            />
          </span>
          {seat.nickname}
        </span>
      ))}
    </div>
  );
}

export type GroupChatProps = {
  groupName: string;
  seats: readonly GroupSeat[];
  messages: readonly GroupMessage[];
  cardStatus: Readonly<Record<string, CardResolution>>;
  busyCardIds?: ReadonlySet<string>;
  workspacePath?: string;
  workspaceId?: string;
  initialDraft?: string;
  /** Screenshot/test hook: show the no-@ wake confirm with this preview. */
  initialWakePreview?: { willWake: number; asleep: number } | null;
  initialUnfolded?: readonly string[];
  initialMentionOpen?: boolean;
  headerActions?: ReactNode;
  onSend: (content: string, to: string[]) => Promise<void> | void;
  onPreviewWake: (
    content: string
  ) => Promise<{ willWake: number; asleep: number }>;
  onResolveCard: (
    cardId: string,
    decision: 'allow_once' | 'allow_always' | 'deny',
    answer?: string
  ) => void;
  onSelectMember?: (memberId: string) => void;
};

export function GroupChat({
  groupName,
  seats,
  messages,
  cardStatus,
  busyCardIds,
  workspacePath,
  workspaceId,
  initialDraft = '',
  initialWakePreview = null,
  initialUnfolded = [],
  initialMentionOpen = false,
  headerActions,
  onSend,
  onPreviewWake,
  onResolveCard,
  onSelectMember,
}: GroupChatProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(
    new Set(initialUnfolded)
  );
  const [wakePreview, setWakePreview] = useState(initialWakePreview);
  const [mentionOpen, setMentionOpen] = useState(initialMentionOpen);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const segments = useMemo(() => segmentStream(messages), [messages]);
  const seatByNick = useMemo(
    () => new Map(seats.map((seat) => [seat.nickname, seat])),
    [seats]
  );
  const busyElsewhere = seats.filter((seat) => seat.busyElsewhere);
  const nicknames = seats.map((seat) => seat.nickname);

  const send = async (force: boolean) => {
    const content = draft.trim();
    if (!content || sending) return;
    const to = extractMentions(content, nicknames);
    if (to.length === 0 && !force) {
      setWakePreview(await onPreviewWake(content));
      return;
    }
    setSending(true);
    try {
      await onSend(content, to);
      setDraft('');
      setWakePreview(null);
    } finally {
      setSending(false);
    }
  };

  const insertMention = (nickname: string) => {
    setDraft((current) => current.replace(/@\S*$/, '') + `@${nickname} `);
    setMentionOpen(false);
    setWakePreview(null);
    textareaRef.current?.focus();
  };

  const renderMessage = (message: GroupMessage) => {
    const author = authorOf(message.envelope.actor);
    const text = bubbleText(message.envelope);
    const card = parseCard(message.envelope.content);
    const handoff = parseHandoff(message.envelope.content);
    const conflict = parseWorktreeConflict(message.envelope.content);
    const seat = seatByNick.get(author.nickname);
    let body: ReactNode;
    if (card?.kind === 'approval') {
      body = (
        <ApprovalCard
          card={card}
          resolution={cardStatus[card.id]}
          busy={busyCardIds?.has(card.id)}
          onResolve={(decision) => onResolveCard(card.id, decision)}
        />
      );
    } else if (card?.kind === 'ask') {
      body = (
        <AskCard
          card={card}
          resolution={cardStatus[card.id]}
          busy={busyCardIds?.has(card.id)}
          onAnswer={(answer) => onResolveCard(card.id, 'allow_once', answer)}
        />
      );
    } else if (handoff) {
      body = <HandoffCard handoff={handoff} />;
    } else if (conflict) {
      body = <WorktreeConflictCard conflict={conflict} />;
    } else {
      body = (
        <SpaceMessageBody
          fromYou={author.you}
          text={text}
          workspacePath={workspacePath}
          workspaceId={workspaceId}
        />
      );
    }
    const receipts = (message.receipts ?? []).map((receipt) => ({
      key: receipt.conversation_id ?? receipt.nickname ?? '',
      name:
        receipt.nickname ??
        seats.find((s) => s.conversationId === receipt.conversation_id)
          ?.nickname,
      state: receiptState(receipt),
    }));
    if (message.origin === 'system' && !conflict) {
      return (
        <p key={message.seq} className="collab-system-line">
          {text}
        </p>
      );
    }
    return (
      <article
        key={message.seq}
        className="collaboration-message"
        data-from={author.you ? 'you' : 'member'}
      >
        {author.you ? null : (
          <div className="collaboration-message-header">
            <button
              type="button"
              className="collaboration-message-avatar collab-focusable"
              aria-label={author.nickname}
              onClick={() => seat && onSelectMember?.(seat.memberId)}
            >
              {seat ? (
                <MemberBotAvatar
                  config={seat.avatar}
                  animated={false}
                  className="h-6 w-6"
                />
              ) : null}
            </button>
            <p className="collaboration-message-name">{author.nickname}</p>
          </div>
        )}
        {body}
        {author.you ? <ReceiptRow receipts={receipts} showNames /> : null}
      </article>
    );
  };

  const mentionQuery = /@(\S*)$/.exec(draft)?.[1];
  const mentionCandidates = seats.filter(
    (seat) => mentionQuery == null || seat.nickname.startsWith(mentionQuery)
  );

  return (
    <div className="collab-main" data-testid="collab-group-chat">
      <header className="collab-main-head">
        <div className="collab-main-head-text">
          <h3 className="collab-main-title">#{groupName}</h3>
          {busyElsewhere.length > 0 ? (
            <p className="collab-main-subtitle">
              {busyElsewhere
                .map((seat) =>
                  THREAD_COPY.busyElsewhere(
                    seat.nickname,
                    seat.busyElsewhere ?? ''
                  )
                )
                .join(' · ')}
            </p>
          ) : null}
        </div>
        <MemberBar seats={seats} />
        {headerActions}
      </header>
      <div
        className="collab-log collaboration-thread-log"
        data-testid="collab-group-log"
      >
        {segments.map((segment) => {
          if (segment.kind === 'message') return renderMessage(segment.message);
          const open = unfolded.has(segment.key);
          return (
            <div key={segment.key} className="contents">
              <button
                type="button"
                className="collab-agent-fold"
                aria-expanded={open}
                data-testid="collab-agent-fold"
                onClick={() =>
                  setUnfolded((current) => {
                    const next = new Set(current);
                    if (open) next.delete(segment.key);
                    else next.add(segment.key);
                    return next;
                  })
                }
              >
                {open ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {open
                  ? THREAD_COPY.agentUnfold
                  : THREAD_COPY.agentFold(
                      segment.messages.length,
                      segment.pair
                    )}
              </button>
              {open ? segment.messages.map(renderMessage) : null}
            </div>
          );
        })}
      </div>
      <div className="collab-composer">
        {wakePreview ? (
          <div
            className="collab-wake-hint"
            role="status"
            data-testid="collab-wake-confirm"
          >
            <BellRing aria-hidden="true" />
            <span className="collab-wake-hint-text">
              {THREAD_COPY.wakeConfirm(
                wakePreview.willWake,
                wakePreview.asleep
              )}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setDraft((d) => (!d || d.endsWith(' ') ? `${d}@` : `${d} @`));
                setWakePreview(null);
                setMentionOpen(true);
                setMentionIndex(0);
                textareaRef.current?.focus();
              }}
            >
              {THREAD_COPY.wakeConfirmMention}
            </Button>
            <Button
              variant="primary"
              size="xs"
              onClick={() => void send(true)}
              disabled={sending}
            >
              {THREAD_COPY.wakeConfirmSend}
            </Button>
          </div>
        ) : null}
        <Popover
          open={mentionOpen && mentionCandidates.length > 0}
          onOpenChange={setMentionOpen}
        >
          <PopoverAnchor asChild>
            <div className="collab-composer-box">
              <Textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                placeholder={THREAD_COPY.composerPlaceholder}
                aria-label={THREAD_COPY.composerPlaceholder}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft(value);
                  setWakePreview(null);
                  const open = /@\S*$/.test(value);
                  setMentionOpen(open);
                  if (open) setMentionIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (mentionOpen && mentionCandidates.length > 0) {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      const delta = event.key === 'ArrowDown' ? 1 : -1;
                      setMentionIndex(
                        (index) =>
                          (index + delta + mentionCandidates.length) %
                          mentionCandidates.length
                      );
                      return;
                    }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                      event.preventDefault();
                      insertMention(
                        mentionCandidates[mentionIndex]?.nickname ?? ''
                      );
                      return;
                    }
                    if (event.key === 'Escape') {
                      setMentionOpen(false);
                      return;
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send(false);
                  }
                }}
              />
              <Button
                variant="icon"
                aria-label={THREAD_COPY.send}
                disabled={!draft.trim() || sending}
                onClick={() => void send(false)}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            side="top"
            className="p-0"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <ul
              className="collab-mention-list"
              role="listbox"
              data-testid="collab-mention-list"
            >
              {mentionCandidates.map((seat, index) => (
                <li key={seat.memberId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === mentionIndex}
                    className="collab-mention-item"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertMention(seat.nickname)}
                  >
                    <span className="collab-chip-dot">
                      <MemberBotAvatar
                        config={seat.avatar}
                        animated={false}
                        className="h-5 w-5"
                      />
                      <span
                        className={cn(
                          'workspace-session-status',
                          `workspace-session-status--${seat.presence.state}`
                        )}
                      />
                    </span>
                    <span className="collab-mention-item-name">
                      {seat.nickname}
                    </span>
                    <span className="collab-mention-item-hint">
                      {mentionConsequence(seat.presence)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
