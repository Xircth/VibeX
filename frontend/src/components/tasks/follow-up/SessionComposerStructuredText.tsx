import { forwardRef, type HTMLAttributes } from 'react';
import { AtSign, Box, Command, File, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  SessionComposerStructuredToken,
  SessionComposerStructuredTokenSegment,
} from './sessionComposerStructuredTokens';

export function getSessionComposerTokenChipTitle(
  token: SessionComposerStructuredToken
): string | undefined {
  return token.kind === 'file' || token.kind === 'element'
    ? (token.title ?? token.value)
    : undefined;
}

export function getSessionComposerTokenChipClassName(
  token: SessionComposerStructuredToken,
  className?: string
): string {
  const toneClassName =
    token.kind === 'slash'
      ? 'session-composer-token-chip--slash border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300'
      : token.kind === 'dollar'
        ? 'session-composer-token-chip--dollar border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : token.kind === 'file'
          ? 'session-composer-token-chip--file border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : token.kind === 'element'
            ? 'session-composer-token-chip--element border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-300'
            : 'session-composer-token-chip--tag border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  const hoverClassName =
    token.kind === 'file'
      ? 'hover:border-sky-500/55 hover:bg-sky-500/15'
      : token.kind === 'element'
        ? 'hover:border-blue-500/55 hover:bg-blue-500/15'
        : token.kind === 'slash'
          ? 'hover:border-violet-500/55 hover:bg-violet-500/15'
          : token.kind === 'dollar'
            ? 'hover:border-emerald-500/55 hover:bg-emerald-500/15'
            : 'hover:border-amber-500/60 hover:bg-amber-500/15';

  return cn(
    'inline-flex max-w-[220px] cursor-default select-none items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] leading-4 transition-colors',
    (token.kind === 'file' || token.kind === 'element') && 'pointer-events-auto',
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
    token.kind === 'file'
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
