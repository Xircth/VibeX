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
              className={cn('conv-message-nav-dot', isActive && 'is-active')}
              onClick={() => onSelect(entry.index)}
              aria-current={isActive ? 'true' : undefined}
              aria-label={`跳转到第 ${entry.ordinal} 条消息`}
              title={entry.preview}
            />
          );
        })}
      </div>
    </nav>
  );
}
