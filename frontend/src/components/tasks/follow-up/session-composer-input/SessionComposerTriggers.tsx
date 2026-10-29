import type { TFunction } from 'i18next';
import type {
  ChatComposerToken,
  ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import type {
  SearchableItem,
  SearchSource,
} from '@astryxdesign/core/Typeahead';
import { ComposerTriggerMenuItem } from './ComposerTriggerMenuItem';

function renderComposerTriggerItem(item: SearchableItem) {
  return <ComposerTriggerMenuItem item={item} />;
}

export function buildSessionComposerTriggers({
  slashSource,
  dollarSource,
  agentMentionSource,
  pluginSource,
  makeToken,
  pluginOnSelect,
  agentMentionsSupported,
  t,
}: {
  slashSource: SearchSource;
  dollarSource: SearchSource;
  agentMentionSource: SearchSource;
  pluginSource: SearchSource;
  makeToken: (item: SearchableItem) => ChatComposerToken;
  pluginOnSelect: (item: SearchableItem) => string;
  agentMentionsSupported: boolean;
  t: TFunction;
}): ChatComposerTrigger[] {
  const renderItem = renderComposerTriggerItem;
  return [
    {
      character: '/',
      searchSource: slashSource,
      onSelect: makeToken,
      renderItem,
      loadingText: t('composer.commands.loading', 'Loading commands...'),
      emptySearchResultsText: t(
        'composer.commands.noMatches',
        'No matching commands found.'
      ),
    },
    {
      character: '$',
      searchSource: dollarSource,
      onSelect: makeToken,
      renderItem,
      loadingText: t('composer.commands.loading', 'Loading commands...'),
      emptySearchResultsText: t(
        'composer.commands.noMatches',
        'No matching commands found.'
      ),
    },
    ...(agentMentionsSupported
      ? [
          {
            character: '&' as const,
            searchSource: agentMentionSource,
            onSelect: makeToken,
            renderItem,
            loadingText: t('agentMention.loading'),
            emptySearchResultsText: t('agentMention.noMatches'),
          },
        ]
      : []),
    {
      character: '!',
      searchSource: pluginSource,
      onSelect: pluginOnSelect,
      renderItem,
      loadingText: t('pluginActions.loading'),
      emptySearchResultsText: t('pluginActions.noMatches'),
    },
  ];
}
