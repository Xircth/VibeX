import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import {
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerToken,
  type ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import type { SearchableItem, SearchSource } from '@astryxdesign/core/Typeahead';
import { searchTagsAndFiles } from '@/lib/searchTagsAndFiles';
import { formatSessionComposerCommand } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';

type TagFileResult = {
  type: 'tag' | 'file';
  label: string;
  description?: string;
};

function toSearchableItem(
  entry: TagFileResult
): SearchableItem {
  return {
    id: `${entry.type}-${entry.label}`,
    label: entry.label,
    auxiliaryData: entry,
  };
}

/**
 * Lightweight markdown composer for inline editing surfaces (review
 * comments, retry editor, denial reasons): plain text + `#` tag / `@` file
 * reference tokens, Enter inserts a newline and Cmd/Ctrl+Enter submits.
 */
export function InlineMarkdownComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  autoFocus = false,
  projectId,
  className,
  maxRows = 6,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  projectId?: string;
  className?: string;
  maxRows?: number;
  label?: string;
}) {
  const handleRef = useRef<ChatComposerInputHandle | null>(null);

  useEffect(() => {
    if (autoFocus && !disabled) {
      handleRef.current?.focus();
    }
  }, [autoFocus, disabled]);

  const tagSource = useMemo<SearchSource>(
    () => ({
      search: async (query) => {
        if (!projectId) return [];
        const results = await searchTagsAndFiles(query.trim(), {
          projectId,
          includeTags: true,
          includeFiles: false,
        });
        return results
          .filter((result) => result.type === 'tag' && result.tag)
          .map((result) =>
            toSearchableItem({
              type: 'tag',
              label: result.tag!.tag_name,
              description: result.tag!.content ?? undefined,
            })
          );
      },
      bootstrap: () => [],
    }),
    [projectId]
  );
  const fileSource = useMemo<SearchSource>(
    () => ({
      search: async (query) => {
        if (!projectId) return [];
        const results = await searchTagsAndFiles(query.trim(), {
          projectId,
          includeTags: false,
          includeFiles: true,
        });
        return results
          .filter((result) => result.type === 'file' && result.file)
          .map((result) =>
            toSearchableItem({
              type: 'file',
              label: result.file!.name,
              description: result.file!.path,
            })
          );
      },
      bootstrap: () => [],
    }),
    [projectId]
  );

  const triggers = useMemo<ChatComposerTrigger[]>(() => {
    const makeToken = (item: SearchableItem): ChatComposerToken => {
      const entry = item.auxiliaryData as TagFileResult;
      const insertText =
        entry.type === 'tag'
          ? formatSessionComposerCommand({
              type: '#',
              key: entry.label,
              value: `#${entry.label}`,
            })
          : formatSessionComposerCommand({
              type: '@',
              key: entry.label,
              value: entry.description ?? entry.label,
            });
      return { value: insertText, label: item.label };
    };
    const triggersList: ChatComposerTrigger[] = [];
    if (projectId) {
      triggersList.push(
        {
          character: '#',
          searchSource: tagSource,
          onSelect: makeToken,
          emptySearchResultsText: 'No matching tags found.',
        },
        {
          character: '@',
          searchSource: fileSource,
          onSelect: makeToken,
          emptySearchResultsText: 'No matching files found.',
        }
      );
    }
    return triggersList;
  }, [fileSource, projectId, tagSource]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      onSubmit?.();
      return;
    }

    // Inline editing surfaces treat plain Enter as a newline — suppress the
    // composer's built-in submit.
    event.preventDefault();
    const handle = handleRef.current;
    handle?.insertText('\n');
    if (handle) onChange(handle.getValue());
  };

  return (
    <ChatComposerInput
      value={value}
      onChange={onChange}
      isDisabled={disabled}
      placeholder={placeholder}
      maxRows={maxRows}
      hasHistory={false}
      pasteAsToken={false}
      triggers={triggers}
      handleRef={handleRef}
      onKeyDown={handleKeyDown}
      label={label}
      className={className}
    />
  );
}
