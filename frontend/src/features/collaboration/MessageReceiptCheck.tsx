import { Check, CheckCheck } from 'lucide-react';

import { MemberMention, type MemberMentionCandidate } from './MemberMention';
import {
  crossChatNoticeCopy,
  receiptCheckLabel,
  receiptCheckState,
  type CrossChatNotice,
  type DeliveryReceipt,
} from './spaceModel';
import { deriveMemberBotAvatar } from './MemberBotAvatar';
import './chatUiPolish.css';

/** Telegram-style delivery check shown bottom-right inside a sent bubble. */
export function MessageReceiptCheck({
  receipts,
}: {
  receipts: ReadonlyArray<DeliveryReceipt>;
}) {
  const state = receiptCheckState(receipts);
  if (!state) return null;
  const label = receiptCheckLabel(receipts);
  const Icon = state === 'delivered' ? CheckCheck : Check;
  return (
    <span
      className="collaboration-receipt-check"
      data-testid="collaboration-receipt-check"
      data-state={state}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={2.25} />
    </span>
  );
}

/** System line in a member DM: `已发消息给 [B]` / `已收到 [A] 的消息`. */
export function CrossChatNoticeLine({
  notice,
  candidates,
}: {
  notice: CrossChatNotice;
  candidates: readonly MemberMentionCandidate[];
}) {
  const { prefix, suffix } = crossChatNoticeCopy(notice);
  const candidate = candidates.find(
    (item) => item.nickname === notice.nickname
  );
  return (
    <div
      className="collaboration-cross-chat-notice"
      data-testid="collaboration-cross-chat-notice"
      data-kind={notice.kind}
      role="note"
    >
      <span className="collaboration-cross-chat-notice-text">
        {prefix}
        <MemberMention
          nickname={notice.nickname}
          avatar={candidate?.avatar ?? deriveMemberBotAvatar(notice.nickname)}
        />
        {suffix}
      </span>
    </div>
  );
}
