import { Check, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ConversationLiveFeedbackNote } from '@/features/conversation/conversationApi';
import { cn } from '@/lib/utils';

export function LiveFeedbackNotes({
  notes,
}: {
  notes: ConversationLiveFeedbackNote[];
}) {
  const { t } = useTranslation('conversation');
  if (notes.length === 0) return null;

  const ordered = [...notes].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );

  return (
    <div className="max-h-28 overflow-y-auto px-3 pb-1">
      <div className="flex flex-col gap-0.5">
        {ordered.map((note) => {
          const delivered = note.status === 'delivered';
          return (
            <div
              key={note.id}
              className={cn(
                'flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] leading-none',
                'border-border/70 bg-muted/40'
              )}
              title={note.text}
            >
              {delivered ? (
                <Check
                  className="h-3 w-3 shrink-0 text-emerald-500"
                  aria-hidden
                />
              ) : (
                <Clock
                  className="h-3 w-3 shrink-0 text-muted-foreground/70"
                  aria-hidden
                />
              )}
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {note.text}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {delivered
                  ? t('liveFeedback.delivered')
                  : t('liveFeedback.pending')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
