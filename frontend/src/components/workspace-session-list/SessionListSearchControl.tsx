import { Search } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SESSION_LIST_ACTION_BUTTON_CLASS,
  SESSION_LIST_ACTION_ICON_CLASS,
} from '@/components/kanban/session-hub/utils';
import { cn } from '@/lib/utils';

export function SessionListSearchControl({
  searchQuery,
  isExpanded,
  searchLabel,
  placeholder,
  onSearchQueryChange,
  onExpandedChange,
}: {
  searchQuery: string;
  isExpanded: boolean;
  searchLabel: string;
  placeholder: string;
  onSearchQueryChange: (value: string) => void;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (isExpanded) {
      searchInputRef.current?.focus();
    }
  }, [isExpanded]);

  return (
    <div
      className={cn(
        'workspace-session-search-shell relative h-7 overflow-hidden',
        isExpanded ? 'w-full' : 'w-7 shrink-0'
      )}
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        hidden={isExpanded}
        className={cn(
          SESSION_LIST_ACTION_BUTTON_CLASS,
          'absolute inset-0',
          searchQuery && 'text-foreground',
          isExpanded && 'hidden'
        )}
        aria-label={searchLabel}
        aria-expanded={false}
        onClick={() => onExpandedChange(true)}
      >
        <Search className={SESSION_LIST_ACTION_ICON_CLASS} />
      </Button>
      <Search
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground',
          !isExpanded && 'hidden'
        )}
      />
      <Input
        ref={searchInputRef}
        hidden={!isExpanded}
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        onBlur={() => onExpandedChange(false)}
        placeholder={placeholder}
        aria-label={searchLabel}
        aria-expanded={true}
        className={cn('h-7 w-full pl-8 text-xs', !isExpanded && 'hidden')}
      />
    </div>
  );
}
