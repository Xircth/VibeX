import { forwardRef, type HTMLAttributes } from 'react';
import { AtSign, Bot, Box, Command, File, Hash, Puzzle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  SessionComposerStructuredToken,
  SessionComposerStructuredTokenSegment,
} from './sessionComposerStructuredTokens';

export function getSessionComposerTokenChipTitle(
  token: SessionComposerStructuredToken
): string | undefined {
  if (token.kind === 'agent_mention') return token.title ?? token.value;
  return token.kind === 'file' ||
    token.kind === 'element' ||
    token.kind === 'plugin_action'
    ? (token.title ?? token.value)
    : undefined;
}

export function getSessionComposerTokenChipClassName(
  token: SessionComposerStructuredToken,
  className?: string
): string {
  const toneClassName =
    token.kind === 'plugin_action'
      ? 'session-composer-token-chip--plugin border-[hsl(var(--primary)/0.35)] bg-[hsl(var(--primary)/0.1)] text-primary'
      : token.kind === 'agent_mention'
        ? 'session-composer-token-chip--agent border-border bg-muted text-foreground'
        : token.kind === 'slash'
          ? 'session-composer-token-chip--slash border-[hsl(var(--status-running)/0.35)] bg-[hsl(var(--status-running)/0.1)] text-[hsl(var(--status-running))]'
          : token.kind === 'dollar'
            ? 'session-composer-token-chip--dollar border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]'
            : token.kind === 'file'
              ? 'session-composer-token-chip--file border-[hsl(var(--info)/0.35)] bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]'
              : token.kind === 'element'
                ? 'session-composer-token-chip--element border-[hsl(var(--primary)/0.35)] bg-[hsl(var(--primary)/0.1)] text-primary'
                : 'session-composer-token-chip--tag border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]';
  const hoverClassName =
    token.kind === 'plugin_action'
      ? 'hover:border-[hsl(var(--primary)/0.55)] hover:bg-[hsl(var(--primary)/0.15)]'
      : token.kind === 'agent_mention'
        ? 'hover:border-border hover:bg-accent'
        : token.kind === 'file'
          ? 'hover:border-[hsl(var(--info)/0.55)] hover:bg-[hsl(var(--info)/0.15)]'
          : token.kind === 'element'
            ? 'hover:border-[hsl(var(--primary)/0.55)] hover:bg-[hsl(var(--primary)/0.15)]'
            : token.kind === 'slash'
              ? 'hover:border-[hsl(var(--status-running)/0.55)] hover:bg-[hsl(var(--status-running)/0.15)]'
              : token.kind === 'dollar'
                ? 'hover:border-[hsl(var(--success)/0.55)] hover:bg-[hsl(var(--success)/0.15)]'
                : 'hover:border-[hsl(var(--warning)/0.6)] hover:bg-[hsl(var(--warning)/0.15)]';

  return cn(
    'inline-flex max-w-[220px] cursor-default select-none items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] leading-4 transition-colors',
    (token.kind === 'file' || token.kind === 'element') &&
      'pointer-events-auto',
    token.kind === 'plugin_action' && 'mr-1',
    hoverClassName,
    toneClassName,
    className
  );
}

export function SessionComposerTokenChip({
  token,
  ...elementProps
}: {
  token: SessionComposerStructuredToken;
} & HTMLAttributes<HTMLSpanElement>) {
  const Icon =
    token.kind === 'plugin_action'
      ? Puzzle
      : token.kind === 'agent_mention'
        ? Bot
        : token.kind === 'file'
          ? File
          : token.kind === 'tag'
            ? Hash
            : token.kind === 'element'
              ? Box
              : Command;

  return (
    <span
      {...elementProps}
      className={getSessionComposerTokenChipClassName(
        token,
        elementProps.className
      )}
      data-testid="session-composer-token-chip"
      data-token-kind={token.kind}
      data-structured-token-atomic="true"
      onMouseDown={(event) => event.preventDefault()}
      title={getSessionComposerTokenChipTitle(token)}
    >
      {token.kind === 'file' || token.kind === 'element' ? (
        <AtSign className="h-3 w-3 shrink-0" />
      ) : null}
      <Icon className="h-3 w-3 shrink-0 opacity-80" />
      <span className="truncate font-medium">{token.label}</span>
    </span>
  );
}

export const SessionComposerStructuredText = forwardRef<
  HTMLDivElement,
  {
    segments: SessionComposerStructuredTokenSegment[];
    caretOffset?: number | null;
    className?: string;
    showEmptyPlaceholder?: boolean;
  } & HTMLAttributes<HTMLDivElement>
>(function SessionComposerStructuredText(
  {
    segments,
    caretOffset = null,
    className,
    showEmptyPlaceholder = false,
    ...elementProps
  },
  ref
) {
  let cursor = 0;
  const renderCaret = (key: string) => (
    <span
      key={key}
      className="inline-block h-4 w-px translate-y-0.5 bg-foreground align-text-bottom"
      data-testid="session-composer-input-caret"
    />
  );

  return (
    <div ref={ref} className={className} {...elementProps}>
      {segments.length > 0
        ? segments.flatMap((segment, index) => {
            if (segment.kind === 'text') {
              const start = cursor;
              const end = start + segment.text.length;
              cursor = end;
              if (
                caretOffset === null ||
                caretOffset < start ||
                caretOffset > end
              ) {
                return [<span key={`text-${index}`}>{segment.text}</span>];
              }

              const relativeCaretOffset = caretOffset - start;
              return [
                <span key={`text-${index}-before`}>
                  {segment.text.slice(0, relativeCaretOffset)}
                </span>,
                renderCaret(`caret-${index}`),
                <span key={`text-${index}-after`}>
                  {segment.text.slice(relativeCaretOffset)}
                </span>,
              ];
            }

            cursor = segment.end;
            const caretBeforeToken = caretOffset === segment.start;
            const caretAfterToken =
              caretOffset === segment.end ||
              (caretOffset !== null &&
                caretOffset > segment.start &&
                caretOffset < segment.end);

            return [
              caretBeforeToken ? renderCaret(`caret-before-${index}`) : null,
              <SessionComposerTokenChip
                key={`${segment.token.raw}-${index}`}
                token={segment.token}
              />,
              caretAfterToken ? renderCaret(`caret-after-${index}`) : null,
            ].filter(Boolean);
          })
        : [
            caretOffset === 0 ? renderCaret('caret-empty') : null,
            showEmptyPlaceholder ? <span key="empty">&nbsp;</span> : null,
          ]}
    </div>
  );
});
