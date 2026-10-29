import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
    <nav
      className="conv-message-nav-rail"
      aria-label={t('messageNav.railLabel')}
    >
      <TooltipProvider delayDuration={80} skipDelayDuration={120}>
        <div className="conv-message-nav-list">
          {entries.map((entry) => {
            const isActive = activeEntry?.key === entry.key;
            return (
              <Tooltip key={entry.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'conv-message-nav-tick',
                      isActive && 'is-active'
                    )}
                    onClick={() => onSelect(entry.index)}
                    aria-current={isActive ? 'true' : undefined}
                    aria-label={t('messageNav.jumpToMessage', {
                      ordinal: entry.ordinal,
                    })}
                  />
                </TooltipTrigger>
                <TooltipContent
                  className="conv-message-nav-preview"
                  side="left"
                  align="center"
                  sideOffset={8}
                  collisionPadding={8}
                >
                  {entry.preview}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    </nav>
  );
}
