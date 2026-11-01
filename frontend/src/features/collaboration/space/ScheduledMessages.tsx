import { Clock } from 'lucide-react';

import { PopoverContent } from '@/components/ui/popover';
import i18n from '@/i18n';

import { DelayedMessageCountdown } from './CollaborationSpaceChrome';
import type { ScheduledSpaceMessage } from './types';
import { useCollaborationSpace } from './SpaceContext';

export function ScheduledMessages({
  nick,
  memberHoverKey,
  items,
}: {
  nick: string;
  memberHoverKey: string;
  items: ScheduledSpaceMessage[];
}) {
  const { openDelayedMemberPopover, scheduleCloseDelayedMemberPopover } =
    useCollaborationSpace();

  return (
    <PopoverContent
      align="start"
      side="bottom"
      sideOffset={6}
      onMouseEnter={() => openDelayedMemberPopover(memberHoverKey)}
      onMouseLeave={scheduleCloseDelayedMemberPopover}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      data-testid={`member-delayed-queue-${nick}`}
      className="collaboration-member-delayed-queue-popover rounded-md border border-border/80 bg-popover p-2 text-popover-foreground shadow-lg"
    >
      <div className="mb-1.5 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3 text-primary" aria-hidden="true" />
          <span>{i18n.t('panels:ui.collabPage.scheduledMessageQueue')}</span>
        </span>
        <span>{items.length}</span>
      </div>
      <div className="collaboration-member-delayed-queue-list">
        {items.map((item) => {
          const itemId = item.id ?? item.delayed_input_id ?? item.deliver_at;
          return (
            <div
              key={itemId}
              className="collaboration-member-delayed-queue-item"
              data-testid={`member-delayed-queue-item-${itemId}`}
            >
              <span
                className="collaboration-member-delayed-queue-content"
                title={item.content}
              >
                {item.content}
              </span>
              <span
                className="collaboration-member-delayed-queue-timer"
                data-testid={`member-delayed-queue-timer-${itemId}`}
              >
                <Clock className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                <DelayedMessageCountdown deliverAt={item.deliver_at} />
              </span>
            </div>
          );
        })}
      </div>
    </PopoverContent>
  );
}
