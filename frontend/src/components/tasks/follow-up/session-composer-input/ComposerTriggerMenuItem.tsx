import type { SearchableItem } from '@astryxdesign/core/Typeahead';
import { SessionComposerTokenIcon } from '../SessionComposerStructuredText';

import { cn } from '@/lib/utils';

import { type SessionComposerStructuredToken } from '../sessionComposerStructuredTokens';

import type { ComposerSearchItemData } from './composerSearch';

export function ComposerTriggerMenuItem({ item }: { item: SearchableItem }) {
  const data = item.auxiliaryData as ComposerSearchItemData | undefined;
  const kind = data?.kind ?? 'file';
  const isCommandRow = kind === 'slash' || kind === 'dollar';
  const iconToken = {
    kind,
    value: data?.agentKind ?? '',
  } satisfies Pick<SessionComposerStructuredToken, 'kind' | 'value'>;

  return (
    <div
      className="flex min-w-0 items-center gap-2.5"
      data-composer-trigger-kind={kind}
    >
      {isCommandRow ? null : (
        <span
          aria-hidden="true"
          className={cn(
            'flex shrink-0 items-center justify-center',
            kind === 'agent_mention' ? 'h-5 w-5' : 'h-7 w-7 rounded-md',
            (kind === 'file' ||
              kind === 'tag' ||
              kind === 'conversation' ||
              kind === 'commit' ||
              kind === 'project' ||
              kind === 'element' ||
              kind === 'quote') &&
              'bg-blue-500/10 text-blue-600 dark:text-blue-300',
            kind === 'plugin_action' &&
              'bg-pink-500/10 text-pink-700 dark:text-pink-300'
          )}
        >
          <SessionComposerTokenIcon
            token={iconToken}
            className={kind === 'agent_mention' ? 'h-5 w-5' : 'h-3.5 w-3.5'}
          />
        </span>
      )}
      <span
        className={cn(
          'min-w-0 flex-1',
          isCommandRow && 'flex items-baseline gap-3'
        )}
      >
        <span
          className={cn(
            'composer-trigger-label font-medium text-foreground',
            isCommandRow ? 'min-w-0 shrink truncate' : 'block truncate'
          )}
          data-composer-trigger-label
        >
          {item.label}
        </span>
        {data?.description ? (
          <span
            className={cn(
              'composer-trigger-description text-muted-foreground',
              isCommandRow
                ? 'ml-auto min-w-0 flex-1 truncate text-right'
                : 'block truncate'
            )}
            data-composer-trigger-description
          >
            {data.description}
          </span>
        ) : null}
      </span>
    </div>
  );
}
