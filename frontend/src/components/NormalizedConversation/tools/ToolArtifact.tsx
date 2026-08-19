import { type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Folder, Globe } from 'lucide-react';
import type { CommandExitStatus, TodoItem } from 'shared/types';
import RawLogText from '@/components/common/RawLogText';
import { cn } from '@/lib/utils';
import {
  getShikiTokenStyle,
  languageFromPath,
  normalizeShikiLanguage,
  useShikiTokens,
} from '@/utils/shikiHighlighter';
import type { ArtifactFact } from './toolArtifactModel';
import { commandExitCode, splitCodeLines } from './toolArtifactModel';

type ToolArtifactProps = {
  badge?: ReactNode;
  title?: ReactNode;
  titleLabel?: string;
  onTitleClick?: () => void;
  meta?: ReactNode;
  additions?: number;
  deletions?: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
};

function handleHeaderKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onToggle?: () => void
) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onToggle?.();
  }
}

export function ToolArtifact({
  badge,
  title,
  titleLabel,
  onTitleClick,
  meta,
  additions,
  deletions,
  expandable = false,
  expanded = true,
  onToggle,
  actions,
  children,
  className,
}: ToolArtifactProps) {
  const hasHeader =
    badge != null ||
    title != null ||
    meta != null ||
    additions != null ||
    deletions != null ||
    actions != null;
  const showBody = Boolean(children) && (expanded || !expandable);

  return (
    <div className={cn('conv-tool-artifact', className)}>
      {hasHeader ? (
        <div
          className={cn('conv-tool-artifact-header', expandable && 'is-toggle')}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? expanded : undefined}
          onClick={expandable ? () => onToggle?.() : undefined}
          onKeyDown={
            expandable
              ? (event) => handleHeaderKeyDown(event, onToggle)
              : undefined
          }
        >
          {badge != null ? (
            <span className="conv-tool-artifact-badge">{badge}</span>
          ) : null}
          {title != null ? (
            onTitleClick ? (
              <button
                type="button"
                className="conv-tool-artifact-title"
                aria-label={titleLabel}
                title={titleLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onTitleClick();
                }}
              >
                {title}
              </button>
            ) : (
              <span className="conv-tool-artifact-title" title={titleLabel}>
                {title}
              </span>
            )
          ) : null}
          <span className="conv-tool-artifact-meta">
            {meta}
            {additions != null && additions > 0 ? (
              <span className="conv-tool-artifact-add">+{additions}</span>
            ) : null}
            {deletions != null && deletions > 0 ? (
              <span className="conv-tool-artifact-del">-{deletions}</span>
            ) : null}
            {actions ? (
              <span
                className="conv-tool-artifact-header-actions"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {actions}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {showBody ? (
        <div className="conv-tool-artifact-body">{children}</div>
      ) : null}
    </div>
  );
}

export function ToolCodeSnippet({
  path,
  content,
  startLine = 1,
}: {
  path?: string | null;
  content: string;
  startLine?: number;
}) {
  const language = normalizeShikiLanguage(languageFromPath(path));
  const tokens = useShikiTokens(content, language);
  const lines = splitCodeLines(content);

  return (
    <div className="conv-tool-code" role="table">
      {lines.map((line, index) => (
        <div className="conv-tool-code-line" key={index} role="row">
          <span className="conv-tool-code-num" role="rowheader">
            {startLine + index}
          </span>
          <span className="conv-tool-code-text" role="cell">
            {(tokens[index] ?? []).map((token, tokenIndex) => (
              <span
                key={`${index}-${token.offset}-${tokenIndex}`}
                style={getShikiTokenStyle(token)}
              >
                {token.content}
              </span>
            ))}
            {line ? null : '\u00a0'}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ToolFacts({ facts }: { facts: ArtifactFact[] }) {
  if (facts.length === 0) return null;

  return (
    <dl className="conv-tool-facts">
      {facts.map((fact, index) => (
        <div className="conv-tool-fact" key={`${fact.key}-${index}`}>
          {fact.key ? <dt>{fact.key}</dt> : null}
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ToolChoiceList({
  items,
  selected,
}: {
  items: string[];
  selected?: string | null;
}) {
  if (items.length === 0) return null;

  return (
    <ul className="conv-tool-choices">
      {items.map((item) => (
        <li
          key={item}
          className={cn('conv-tool-choice', selected === item && 'is-selected')}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

export function ToolTerminal({
  command,
  output,
  exitStatus,
  linkifyUrls = false,
}: {
  command: string;
  output?: string | null;
  exitStatus?: CommandExitStatus | null;
  linkifyUrls?: boolean;
}) {
  const { t } = useTranslation('conversation');
  const exit = commandExitCode(exitStatus);

  return (
    <ToolArtifact
      badge="$"
      title={command}
      titleLabel={command}
      meta={
        exit.code != null ? (
          <span
            className={cn(
              'conv-tool-terminal-exit',
              exit.ok === false && 'is-error',
              exit.ok && 'is-ok'
            )}
          >
            {t('toolArtifact.exitCode', { code: exit.code })}
          </span>
        ) : null
      }
    >
      {output ? (
        <div className="conv-tool-terminal-output">
          <RawLogText content={output} linkifyUrls={linkifyUrls} />
        </div>
      ) : null}
    </ToolArtifact>
  );
}

export function ToolSearchHits({
  items,
  onOpenUrl,
  onOpenPath,
  onOpenDirectory,
}: {
  items: Array<{
    path: string | null;
    url: string | null;
    line: string | null;
    text: string;
    directory?: boolean;
  }>;
  onOpenUrl?: (url: string) => void;
  onOpenPath?: (path: string, line?: number) => void;
  onOpenDirectory?: (path: string) => void;
}) {
  const { t } = useTranslation('conversation');
  if (items.length === 0) return null;

  return (
    <ul
      className="conv-tool-hits"
      aria-label={t('messageTurnView.searchResults')}
    >
      {items.map((item, index) => {
        const lineNumber = item.line ? Number(item.line) : undefined;
        const handleClick = () => {
          if (item.url) {
            onOpenUrl?.(item.url);
            return;
          }
          if (item.path && item.directory) {
            onOpenDirectory?.(item.path);
            return;
          }
          if (item.path) {
            onOpenPath?.(
              item.path,
              Number.isFinite(lineNumber) ? lineNumber : undefined
            );
          }
        };
        const clickable = Boolean(
          (item.url && onOpenUrl) ||
            (item.path && item.directory && onOpenDirectory) ||
            (item.path && onOpenPath)
        );

        return (
          <li key={`${item.path ?? item.url ?? 'hit'}-${item.line ?? index}`}>
            {clickable ? (
              <button
                type="button"
                className="conv-tool-hit-button"
                onClick={handleClick}
              >
                <span className="conv-tool-hit-icon" aria-hidden>
                  {item.url ? (
                    <Globe className="h-3 w-3" />
                  ) : item.directory ? (
                    <Folder className="h-3 w-3" />
                  ) : (
                    <FileText className="h-3 w-3" />
                  )}
                </span>
                <span className="conv-tool-hit-loc">
                  {item.url ?? item.path}
                  {item.line ? <span>:{item.line}</span> : null}
                </span>
                {item.text &&
                item.text !== item.url &&
                item.text !== item.path ? (
                  <span className="conv-tool-hit-text">{item.text}</span>
                ) : null}
              </button>
            ) : (
              <>
                {item.path || item.url ? (
                  <span className="conv-tool-hit-loc">
                    <span>{item.url ?? item.path}</span>
                    {item.line ? <span>:{item.line}</span> : null}
                  </span>
                ) : null}
                {item.text ? (
                  <span className="conv-tool-hit-text">{item.text}</span>
                ) : null}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ToolTodoList({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;

  return (
    <ul className="conv-tool-todos">
      {todos.map((todo, index) => (
        <li
          key={`${todo.content}-${index}`}
          className={cn('conv-tool-todo', `is-${todo.status}`)}
        >
          <span className="conv-tool-todo-mark" aria-hidden>
            {todo.status === 'completed'
              ? '✓'
              : todo.status === 'in_progress'
                ? '•'
                : ''}
          </span>
          <span className="conv-tool-todo-text">{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}

export function ToolProse({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('conv-tool-prose', className)}>{children}</div>;
}
