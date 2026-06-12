import { MessageSquareText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ConversationMessageNavEntry } from './messageNavEntries';
import { findActiveConversationMessageNavEntry } from './messageNavEntries';

export function ConversationMessageNav({
  entries,
  activeIndex,
  onSelect,
}: {
  entries: ConversationMessageNavEntry[];
  activeIndex: number | null;
  onSelect: (index: number) => void;
}) {
  if (entries.length === 0) return null;

  const activeEntry = findActiveConversationMessageNavEntry(
    entries,
    activeIndex
  );

  return (
    <nav className="conv-message-nav-rail" aria-label="消息导航">
      <div className="conv-message-nav-list">
        {entries.map((entry) => {
          const isActive = activeEntry?.key === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              className={cn(
                'conv-message-nav-button',
                isActive && 'is-active'
              )}
              onClick={() => onSelect(entry.index)}
              aria-current={isActive ? 'true' : undefined}
              title={entry.preview}
            >
              <MessageSquareText className="h-3.5 w-3.5 shrink-0" />
              <span className="conv-message-nav-ordinal">
                {entry.ordinal}
              </span>
              <span className="conv-message-nav-preview">{entry.preview}</span>
              {entry.additions > 0 || entry.deletions > 0 ? (
                <span className="conv-message-nav-stats">
                  {entry.additions > 0 ? (
                    <span className="conv-message-nav-add">
                      +{entry.additions}
                    </span>
                  ) : null}
                  {entry.deletions > 0 ? (
                    <span className="conv-message-nav-del">
                      -{entry.deletions}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
