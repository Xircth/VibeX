import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation(['conversation', 'common']);

  if (entries.length === 0) return null;

  const activeEntry = findActiveConversationMessageNavEntry(
    entries,
    activeIndex
  );

  return (
    <nav className="conv-message-nav-rail" aria-label={t('messageNav.railLabel')}>
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
              aria-label={t('messageNav.jumpToMessage', {
                ordinal: entry.ordinal,
              })}
              title={entry.preview}
            />
          );
        })}
      </div>
    </nav>
  );
}
