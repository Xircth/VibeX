import { useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  CircleAlert,
  Clock,
  Loader2,
  MessageCircleQuestion,
  ShieldCheck,
  Sunrise,
  TriangleAlert,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import {
  THREAD_COPY,
  receiptLabel,
  type CardView,
  type HandoffView,
  type ReceiptState,
  type WorktreeConflictView,
} from './threadModel';

export function HandoffCard({
  handoff,
  from,
  onViewProcess,
}: {
  handoff: HandoffView;
  from?: string;
  onViewProcess?: () => void;
}) {
  return (
    <section className="collab-card" data-testid="collab-handoff-card">
      <h4 className="collab-card-title">
        <ArrowRightLeft aria-hidden="true" />
        {from
          ? `${THREAD_COPY.handoffTitle} · ${from}`
          : THREAD_COPY.handoffTitle}
      </h4>
      {(
        [
          [THREAD_COPY.handoffDone, handoff.done],
          [THREAD_COPY.handoffInputs, handoff.inputsConstraints],
          [THREAD_COPY.handoffAsk, handoff.ask],
        ] as const
      ).map(([label, text]) =>
        text ? (
          <div key={label} className="collab-card-field">
            <p className="collab-card-label">{label}</p>
            <p className="collab-card-text">{text}</p>
          </div>
        ) : null
      )}
      {onViewProcess ? (
        <div className="collab-card-actions">
          <Button variant="ghost" size="sm" onClick={onViewProcess}>
            {THREAD_COPY.viewProcess}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export type CardResolution = {
  status: 'pending' | 'resolved';
  decision?: string | null;
  answer?: string | null;
};

const DECISION_LABEL: Record<string, string> = {
  allow_once: THREAD_COPY.approvalOnce,
  allow_always: THREAD_COPY.approvalAlways,
  deny: THREAD_COPY.approvalDeny,
};

export function ResolvedCardLine({ text }: { text: string }) {
  return (
    <div
      className="collab-card collab-card--resolved"
      data-testid="collab-card-resolved"
    >
      <Check className="h-4 w-4" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

export function ApprovalCard({
  card,
  from,
  resolution,
  busy,
  onResolve,
}: {
  card: Extract<CardView, { kind: 'approval' }>;
  from?: string;
  resolution?: CardResolution;
  busy?: boolean;
  onResolve: (decision: 'allow_once' | 'allow_always' | 'deny') => void;
}) {
  if (resolution?.status === 'resolved') {
    return (
      <ResolvedCardLine
        text={THREAD_COPY.resolvedDecision(
          DECISION_LABEL[resolution.decision ?? ''] ?? resolution.decision ?? ''
        )}
      />
    );
  }
  return (
    <section
      className="collab-card"
      data-testid="collab-approval-card"
      tabIndex={0}
      aria-label={THREAD_COPY.approvalTitle}
      onKeyDown={(event) => {
        if (busy || event.target !== event.currentTarget) return;
        if (event.key === 'a' || event.key === 'A') onResolve('allow_once');
        if (event.key === 'd' || event.key === 'D') onResolve('deny');
      }}
    >
      <h4 className="collab-card-title">
        <ShieldCheck aria-hidden="true" />
        {from
          ? `${THREAD_COPY.approvalTitle} · ${from}`
          : THREAD_COPY.approvalTitle}
      </h4>
      {card.action ? <p className="collab-card-text">{card.action}</p> : null}
      {card.command ? (
        <pre className="collab-card-code">{card.command}</pre>
      ) : null}
      {card.reason ? (
        <p className="collab-card-text collab-profile-row-sub">{card.reason}</p>
      ) : null}
      <div className="collab-card-actions">
        <Button
          size="default"
          disabled={busy}
          onClick={() => onResolve('allow_once')}
        >
          {THREAD_COPY.approvalOnce}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => onResolve('allow_always')}
        >
          {THREAD_COPY.approvalAlways}
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => onResolve('deny')}
        >
          {THREAD_COPY.approvalDeny}
        </Button>
      </div>
    </section>
  );
}

export function AskCard({
  card,
  from,
  resolution,
  busy,
  onAnswer,
}: {
  card: Extract<CardView, { kind: 'ask' }>;
  from?: string;
  resolution?: CardResolution;
  busy?: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [other, setOther] = useState<string | null>(null);
  if (resolution?.status === 'resolved') {
    return (
      <ResolvedCardLine
        text={THREAD_COPY.resolvedAnswer(resolution.answer ?? '')}
      />
    );
  }
  return (
    <section className="collab-card" data-testid="collab-ask-card">
      <h4 className="collab-card-title">
        <MessageCircleQuestion aria-hidden="true" />
        {from ? `${THREAD_COPY.askTitle} · ${from}` : THREAD_COPY.askTitle}
      </h4>
      <p className="collab-card-text">{card.question}</p>
      {other === null ? (
        <div className="collab-card-actions">
          {card.options.map((option, index) => (
            <Button
              key={option}
              variant={index === 0 ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => onAnswer(option)}
            >
              {option}
            </Button>
          ))}
          <Button variant="ghost" disabled={busy} onClick={() => setOther('')}>
            {THREAD_COPY.askOther}
          </Button>
        </div>
      ) : (
        <form
          className="collab-card-actions"
          onSubmit={(event) => {
            event.preventDefault();
            if (other.trim()) onAnswer(other.trim());
          }}
        >
          <Input
            autoFocus
            className="flex-1"
            value={other}
            aria-label={THREAD_COPY.askOther}
            onChange={(event) => setOther(event.target.value)}
          />
          <Button type="submit" disabled={busy || !other.trim()}>
            {THREAD_COPY.askSubmit}
          </Button>
        </form>
      )}
    </section>
  );
}

export function WorktreeConflictCard({
  conflict,
  onNewWorktree,
  onWait,
  onView,
}: {
  conflict: WorktreeConflictView;
  onNewWorktree?: () => void;
  onWait?: () => void;
  onView?: () => void;
}) {
  return (
    <section className="collab-card" data-testid="collab-conflict-card">
      <h4 className="collab-card-title">
        <TriangleAlert
          className="collab-card-icon--warning"
          aria-hidden="true"
        />
        {THREAD_COPY.conflictTitle}
      </h4>
      <p className="collab-card-text">
        {`${conflict.holder} 正在使用 `}
        <span className="collab-mono">{conflict.branch}</span>
        {'，同时写入会互相覆盖。'}
      </p>
      {conflict.path ? (
        <pre className="collab-card-code">{conflict.path}</pre>
      ) : null}
      <div className="collab-card-actions">
        <Button onClick={onNewWorktree}>{THREAD_COPY.conflictNew}</Button>
        <Button variant="secondary" onClick={onWait}>
          {THREAD_COPY.conflictWait}
        </Button>
        <Button variant="ghost" onClick={onView}>
          {THREAD_COPY.conflictView}
        </Button>
      </div>
    </section>
  );
}

const RECEIPT_ICON: Record<ReceiptState, typeof Clock> = {
  queued: Clock,
  waking: Sunrise,
  processing: Loader2,
  replied: Check,
  limit_reached: CircleAlert,
  failed: CircleAlert,
};

/** Right-aligned receipts under a user message: one entry per recipient. */
export function ReceiptRow({
  receipts,
  showNames,
  onRetry,
}: {
  receipts: readonly { key: string; name?: string; state: ReceiptState }[];
  showNames?: boolean;
  onRetry?: () => void;
}) {
  if (receipts.length === 0) return null;
  return (
    <ul
      className="collaboration-receipts"
      data-align="end"
      data-testid="collab-receipts"
    >
      {receipts.map((receipt) => {
        const Icon = RECEIPT_ICON[receipt.state];
        return (
          <li
            key={receipt.key}
            className="collaboration-receipt"
            data-status={receipt.state === 'failed' ? 'failed' : receipt.state}
            data-current="true"
          >
            <Icon
              className={cn(
                'h-3 w-3',
                receipt.state === 'processing' &&
                  'animate-spin motion-reduce:animate-none'
              )}
              aria-hidden="true"
            />
            {showNames && receipt.name ? `${receipt.name} · ` : ''}
            {receiptLabel(receipt.state)}
          </li>
        );
      })}
      {onRetry && receipts.some((r) => r.state === 'failed') ? (
        <li>
          <Button variant="ghost" size="xs" onClick={onRetry}>
            {THREAD_COPY.retry}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
