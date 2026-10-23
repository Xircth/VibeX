import {
  Fragment,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { MessageTurn } from 'shared/types';

import { Button } from '@/components/ui/button';
import type { AtReferenceMember } from '@/components/tasks/follow-up/composerAtReferences';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';

import { CollabComposer } from './CollabComposer';
import {
  MemberMentionProvider,
  type MemberMentionCandidate,
} from './MemberMention';
import { CrossChatNoticeLine } from './MessageReceiptCheck';
import type { MemberBotAvatarConfig } from './MemberBotAvatar';
import { SpaceMessageBody } from './SpaceMessageBody';
import { ReceiptRow } from './ThreadCards';
import {
  THREAD_COPY,
  formatDuration,
  processSummary,
  type DirectChatNotice,
  type ReceiptState,
} from './threadModel';

type TurnPhase = ComponentProps<typeof MessageTurnView>['phase'];

export type DirectChatTurn = {
  key: string;
  turn: MessageTurn;
  phase?: TurnPhase;
};

/** Text the member actually said: text blocks after the last process step. */
export function finalAssistantText(turn: MessageTurn): string {
  const blocks = turn.blocks ?? [];
  let lastProcess = -1;
  blocks.forEach((block, index) => {
    if (block.type !== 'text') lastProcess = index;
  });
  const tail = blocks
    .slice(lastProcess + 1)
    .filter(
      (block): block is Extract<typeof block, { type: 'text' }> =>
        block.type === 'text'
    );
  const source =
    tail.length > 0 ? tail : blocks.filter((b) => b.type === 'text');
  return source
    .map((block) => (block as { text: string }).text)
    .join('\n\n')
    .trim();
}

/** The turn minus its trailing final text (already shown above the fold). */
export function processOnlyTurn(turn: MessageTurn): MessageTurn {
  const blocks = turn.blocks ?? [];
  let end = blocks.length;
  while (end > 0 && blocks[end - 1].type === 'text') end -= 1;
  return end === 0 || end === blocks.length
    ? turn
    : { ...turn, blocks: blocks.slice(0, end) };
}

export function userTurnText(turn: MessageTurn): string {
  return (turn.blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n\n')
    .trim();
}

/**
 * Receipt for each user turn. Live receipts (from submit / receipts-changed)
 * win; otherwise a user turn followed by an assistant turn is `replied`, and
 * the last unanswered one is `processing` while a turn is in flight.
 */
export function directReceipts(
  turns: readonly DirectChatTurn[],
  live: Readonly<Record<string, ReceiptState>>,
  inFlight: boolean
): Record<string, ReceiptState> {
  const out: Record<string, ReceiptState> = {};
  turns.forEach((entry, index) => {
    if (entry.turn.role !== 'user') return;
    const replied = turns
      .slice(index + 1)
      .some(
        (next) => next.turn.role === 'assistant' && next.phase !== 'streaming'
      );
    const answering = turns
      .slice(index + 1)
      .some((next) => next.turn.role === 'assistant');
    out[entry.key] =
      live[entry.key] ??
      (replied ? 'replied' : answering || inFlight ? 'processing' : 'queued');
  });
  return out;
}

function ProcessFold({
  entry,
  workspacePath,
  workspaceId,
  onOpenSession,
  defaultOpen,
}: {
  entry: DirectChatTurn;
  workspacePath?: string;
  workspaceId?: string;
  onOpenSession?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const summary = processSummary(entry.turn);
  if (summary.steps === 0) return null;
  const parts = [
    THREAD_COPY.process(summary.steps),
    summary.tools > 0 ? THREAD_COPY.processTools(summary.tools) : null,
    formatDuration(summary.durationMs) || null,
  ].filter(Boolean);
  return (
    <div
      className="collab-process"
      data-testid="collab-process"
      data-open={open}
    >
      <div className="collab-process-row">
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        <span className="collab-process-row-label">{parts.join(' · ')}</span>
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? THREAD_COPY.hideProcess : THREAD_COPY.viewProcess}
        </Button>
        {onOpenSession ? (
          <Button variant="ghost" size="xs" onClick={onOpenSession}>
            {THREAD_COPY.openSession}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="collab-process-body">
          <MessageTurnView
            turn={processOnlyTurn(entry.turn)}
            phase={entry.phase}
            attempt={
              {
                id: workspaceId ?? 'collaboration',
                container_ref: workspacePath ?? null,
              } as never
            }
            task={null}
            workspacePath={workspacePath}
            collapseProcess={false}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Member direct chat: only the back-and-forth; process folded per reply. */
export function MemberDirectChatLog({
  turns,
  receipts,
  memberName,
  avatar,
  workspacePath,
  workspaceId,
  onOpenSession,
  expandedKeys,
  inlineCards,
  notices = [],
  mentionCandidates = [],
}: {
  turns: readonly DirectChatTurn[];
  receipts: Readonly<Record<string, ReceiptState>>;
  memberName: string;
  avatar: ReactNode;
  workspacePath?: string;
  workspaceId?: string;
  onOpenSession?: () => void;
  /** Test/screenshot hook: process folds opened initially. */
  expandedKeys?: readonly string[];
  /** Pending ask/approval cards for this member, rendered at the end. */
  inlineCards?: ReactNode;
  /** Cross-DM lines (`已发消息给 [B]` / `已收到 [A] 的消息`), by time. */
  notices?: readonly DirectChatNotice[];
  mentionCandidates?: readonly MemberMentionCandidate[];
}) {
  const noticesBefore = placeNotices(turns, notices);
  const renderNotices = (list: readonly DirectChatNotice[] | undefined) =>
    (list ?? []).map((notice) => (
      <CrossChatNoticeLine
        key={notice.key}
        notice={notice}
        candidates={mentionCandidates}
      />
    ));
  return (
    <div
      className="collab-log collaboration-thread-log"
      data-testid="collab-direct-log"
    >
      {turns.map((entry) => (
        <Fragment key={entry.key}>
          {renderNotices(noticesBefore.get(entry.key))}
          {renderTurn(entry)}
        </Fragment>
      ))}
      {renderNotices(noticesBefore.get(TAIL))}
      {inlineCards}
    </div>
  );

  function renderTurn(entry: DirectChatTurn) {
    if (entry.turn.role === 'user') {
      return (
        <article
          key={entry.key}
          className="collaboration-message"
          data-from="you"
        >
          <SpaceMessageBody
            fromYou
            text={userTurnText(entry.turn)}
            workspacePath={workspacePath}
            workspaceId={workspaceId}
          />
          <ReceiptRow
            receipts={
              receipts[entry.key]
                ? [{ key: entry.key, state: receipts[entry.key] }]
                : []
            }
          />
        </article>
      );
    }
    if (entry.turn.role !== 'assistant') return null;
    const text = finalAssistantText(entry.turn);
    return (
      <article
        key={entry.key}
        className="collaboration-message"
        data-from="member"
      >
        <div className="collaboration-message-header">
          <span className="collaboration-message-avatar">{avatar}</span>
          <p className="collaboration-message-name">{memberName}</p>
        </div>
        {text ? (
          <SpaceMessageBody
            fromYou={false}
            text={text}
            workspacePath={workspacePath}
            workspaceId={workspaceId}
          />
        ) : null}
        <ProcessFold
          entry={entry}
          workspacePath={workspacePath}
          workspaceId={workspaceId}
          onOpenSession={onOpenSession}
          defaultOpen={expandedKeys?.includes(entry.key)}
        />
      </article>
    );
  }
}

const TAIL = '\u0000tail';

/** Group notices under the first turn that starts after them (else tail). */
function placeNotices(
  turns: readonly DirectChatTurn[],
  notices: readonly DirectChatNotice[]
): Map<string, DirectChatNotice[]> {
  const out = new Map<string, DirectChatNotice[]>();
  for (const notice of notices) {
    const at = notice.at ? Date.parse(notice.at) : NaN;
    const next = Number.isNaN(at)
      ? undefined
      : turns.find((entry) => Date.parse(entry.turn.timestamp) > at);
    const key = next?.key ?? TAIL;
    out.set(key, [...(out.get(key) ?? []), notice]);
  }
  return out;
}

export function DirectComposer({
  memberName,
  sending,
  onSend,
  members = [],
  workspaceId,
  workspacePath,
}: {
  memberName: string;
  sending?: boolean;
  onSend: (content: string) => void;
  /** Members that `@` can reference (rendered as MemberMention chips). */
  members?: readonly AtReferenceMember[];
  workspaceId?: string;
  workspacePath?: string;
}) {
  const [draft, setDraft] = useState('');
  const replaceDraftRef = useRef<((next: string) => void) | null>(null);
  const send = (value: string = draft) => {
    const content = value.trim();
    if (!content || sending) return;
    onSend(content);
    setDraft('');
    replaceDraftRef.current?.('');
  };
  const label = `发消息给 ${memberName}`;
  return (
    <div className="collab-composer">
      <MemberMentionProvider candidates={chipCandidates(members)}>
        <CollabComposer
          value={draft}
          label={label}
          sessionId={`collab-direct-${memberName}`}
          members={members}
          disabled={sending}
          workspaceId={workspaceId}
          workspacePath={workspacePath}
          replaceValueRef={replaceDraftRef}
          onChange={setDraft}
          onSubmit={send}
        />
      </MemberMentionProvider>
    </div>
  );
}

function chipCandidates(members: readonly AtReferenceMember[]) {
  return members.flatMap((member) =>
    member.avatar
      ? [
          {
            nickname: member.nickname,
            avatar: member.avatar as MemberBotAvatarConfig,
          },
        ]
      : []
  );
}
