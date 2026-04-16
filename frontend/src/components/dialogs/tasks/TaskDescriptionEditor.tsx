import { useCallback, useEffect, useRef, useState } from 'react';
import { Command, Workflow, FileText, Tag } from 'lucide-react';
import type { ExecutorProfileId } from 'shared/types';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { extractImageFilesFromClipboardData } from '@/utils/clipboard';
import { searchTagsAndFiles } from '@/lib/searchTagsAndFiles';
import { fileTreeApi, repoApi } from '@/lib/api';
import { DOLLAR_COMMANDS } from '@/components/ui/wysiwyg/plugins/dollar-command-typeahead-plugin';

type TriggerKind = 'slash' | 'dollar' | 'tag' | 'file';

type TriggerMatch = {
  kind: TriggerKind;
  query: string;
  start: number;
  end: number;
};

type EditorOption = {
  key: string;
  label: string;
  detail?: string;
  insertText: string;
  icon: 'slash' | 'dollar' | 'tag' | 'file';
} | null;

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  projectId?: string;
  repoIds?: string[];
  repoId?: string;
  executorProfile?: ExecutorProfileId | null;
  onPasteFiles?: (files: File[]) => void;
  onCmdEnter?: () => void;
  className?: string;
};

function getMatch(text: string, cursor: number): TriggerMatch | null {
  const prefix = text.slice(0, cursor);
  const patterns: Array<[TriggerKind, RegExp]> = [
    ['slash', /(?:^|\s)\/([^\s/]*)$/],
    ['dollar', /(?:^|\s)\$([^\s$]*)$/],
    ['tag', /(?:^|\s)#([^\s#@]*)$/],
    ['file', /(?:^|\s)@([^\s#@]*)$/],
  ];

  for (const [kind, pattern] of patterns) {
    const match = pattern.exec(prefix);
    if (!match) continue;
    const fullMatch = match[0];
    const triggerChar =
      kind === 'slash'
        ? '/'
        : kind === 'dollar'
          ? '$'
          : kind === 'tag'
            ? '#'
            : '@';
    const start =
      prefix.length - fullMatch.length + fullMatch.indexOf(triggerChar);
    return {
      kind,
      query: match[1] ?? '',
      start,
      end: cursor,
    };
  }

  return null;
}

function filterByName<T extends { name: string }>(
  items: T[],
  query: string
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  const startsWith = items.filter((item) =>
    item.name.toLowerCase().startsWith(normalized)
  );
  const includes = items.filter(
    (item) =>
      !startsWith.includes(item) && item.name.toLowerCase().includes(normalized)
  );
  return [...startsWith, ...includes];
}

function getOptionIcon(icon: NonNullable<EditorOption>['icon']) {
  switch (icon) {
    case 'slash':
      return <Command className="h-3.5 w-3.5" />;
    case 'dollar':
      return <Workflow className="h-3.5 w-3.5" />;
    case 'tag':
      return <Tag className="h-3.5 w-3.5" />;
    case 'file':
      return <FileText className="h-3.5 w-3.5" />;
  }
}

export function TaskDescriptionEditor({
  value,
  onChange,
  disabled = false,
  placeholder = '',
  projectId,
  repoIds,
  repoId,
  executorProfile,
  onPasteFiles,
  onCmdEnter,
  className,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [match, setMatch] = useState<TriggerMatch | null>(null);
  const [options, setOptions] = useState<EditorOption[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  const slashCommands = useSlashCommands(executorProfile, {
    repoId,
  });

  const syncMatchFromTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const nextMatch = getMatch(value, textarea.selectionStart ?? value.length);
    setMatch(nextMatch);
    setSelectedIndex(0);
  }, [value]);

  useEffect(() => {
    syncMatchFromTextarea();
  }, [syncMatchFromTextarea]);

  useEffect(() => {
    let cancelled = false;

    async function loadOptions() {
      if (!match) {
        setOptions([]);
        setLoading(false);
        return;
      }

      if (match.kind === 'slash') {
        const commands = filterByName(
          (slashCommands.commands ?? []).map((command) => ({
            name: command.name,
            description: command.description ?? undefined,
          })),
          match.query
        ).map<EditorOption>((command) => ({
          key: `slash-${command.name}`,
          label: `/${command.name}`,
          detail: command.description,
          insertText: `/${command.name} `,
          icon: 'slash',
        }));
        setOptions(commands);
        setLoading(false);
        return;
      }

      if (match.kind === 'dollar') {
        const workflows = filterByName(
          DOLLAR_COMMANDS.map((command) => ({
            name: command.name,
            description: command.description,
          })),
          match.query
        ).map<EditorOption>((command) => ({
          key: `dollar-${command.name}`,
          label: `$${command.name}`,
          detail: command.description,
          insertText: `$${command.name} `,
          icon: 'dollar',
        }));
        setOptions(workflows);
        setLoading(false);
        return;
      }

      setLoading(true);

      if (match.kind === 'tag') {
        const results = await searchTagsAndFiles(match.query, {
          projectId,
          includeTags: true,
          includeFiles: false,
        });
        if (cancelled) return;
        setOptions(
          results
            .filter((result) => result.type === 'tag' && result.tag)
            .map<EditorOption>((result) => {
              const tag = result.tag!;
              const insertText = tag.content
                ? `[#${tag.tag_name}]:\n${tag.content}\n`
                : `#${tag.tag_name} `;
              return {
                key: `tag-${tag.id}`,
                label: `#${tag.tag_name}`,
                detail: tag.content || undefined,
                insertText,
                icon: 'tag',
              };
            })
        );
        setLoading(false);
        return;
      }

      if (match.kind === 'file') {
        if (match.query.trim() === '' && repoId) {
          try {
            const repo = await repoApi.getById(repoId);
            const rootEntries = await fileTreeApi.listDirectoryChildren(
              repo.path,
              ''
            );
            if (cancelled) return;
            const rootOptions = [
              ...rootEntries.directories.map<EditorOption>((path) => ({
                key: `dir-${path}`,
                label: path.split('/').pop() || path,
                detail: path,
                insertText: `${path} `,
                icon: 'file',
              })),
              ...rootEntries.files.map<EditorOption>((path) => ({
                key: `file-${path}`,
                label: path.split('/').pop() || path,
                detail: path,
                insertText: `${path} `,
                icon: 'file',
              })),
            ].slice(0, 12);
            setOptions(rootOptions);
          } catch {
            if (!cancelled) {
              setOptions([]);
            }
          } finally {
            if (!cancelled) {
              setLoading(false);
            }
          }
          return;
        }

        const results = await searchTagsAndFiles(match.query, {
          repoIds,
          projectId,
          includeTags: false,
          includeFiles: true,
        });
        if (cancelled) return;
        setOptions(
          results
            .filter((result) => result.type === 'file' && result.file)
            .map<EditorOption>((result) => {
              const file = result.file!;
              return {
                key: `file-${file.path}`,
                label: file.name,
                detail: file.path,
                insertText: `${file.path} `,
                icon: 'file',
              };
            })
        );
        setLoading(false);
      }
    }

    void loadOptions();

    return () => {
      cancelled = true;
    };
  }, [match, projectId, repoId, repoIds, slashCommands.commands]);

  const applyOption = useCallback(
    (option: EditorOption) => {
      if (!option || !match) return;
      const nextValue =
        value.slice(0, match.start) +
        option.insertText +
        value.slice(match.end);
      onChange(nextValue);

      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const nextCursor = match.start + option.insertText.length;
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
        setMatch(null);
        setOptions([]);
      });
    },
    [match, onChange, value]
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(event.target.value);
      const cursor = event.target.selectionStart ?? event.target.value.length;
      setMatch(getMatch(event.target.value, cursor));
      setSelectedIndex(0);
    },
    [onChange]
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onPasteFiles || disabled) return;
      const files = extractImageFilesFromClipboardData(event.clipboardData);
      if (files.length > 0) {
        event.preventDefault();
        onPasteFiles(files);
      }
    },
    [disabled, onPasteFiles]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const hasMenu = loading || options.length > 0;
      if (hasMenu) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedIndex((prev) =>
            Math.min(prev + 1, Math.max(options.length - 1, 0))
          );
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const option = options[selectedIndex];
          if (option) {
            event.preventDefault();
            applyOption(option);
            return;
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setMatch(null);
          setOptions([]);
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        onCmdEnter?.();
      }
    },
    [applyOption, loading, onCmdEnter, options, selectedIndex]
  );

  const menuVisible = !!match && (loading || options.length > 0);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onClick={syncMatchFromTextarea}
        onKeyUp={syncMatchFromTextarea}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        className={
          className ??
          'min-h-[360px] w-full resize-none bg-transparent outline-none'
        }
      />

      {menuVisible ? (
        <div className="absolute left-0 top-full z-[20000] mt-2 w-[360px] overflow-hidden rounded-md border bg-background shadow-lg">
          <div className="border-b bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {match.kind === 'slash'
              ? 'Commands'
              : match.kind === 'dollar'
                ? 'Workflow Commands'
                : match.kind === 'tag'
                  ? 'Tags'
                  : 'Files'}
          </div>
          <div className="max-h-[280px] overflow-auto py-1">
            {loading ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                加载中...
              </div>
            ) : (
              options.map((option, index) => (
                <button
                  key={option?.key ?? index}
                  type="button"
                  className={`w-full px-3 py-2 text-left text-sm ${
                    index === selectedIndex
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => option && applyOption(option)}
                >
                  {option ? (
                    <>
                      <div className="flex items-center gap-2 font-medium">
                        {getOptionIcon(option.icon)}
                        <span>{option.label}</span>
                      </div>
                      {option.detail ? (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {option.detail}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
