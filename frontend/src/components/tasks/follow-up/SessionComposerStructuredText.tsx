import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import type { BadgeVariant } from '@astryxdesign/core/Badge';
import { Command, Puzzle, Sparkles } from 'lucide-react';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { cn } from '@/lib/utils';
import type {
  SessionComposerStructuredToken,
  SessionComposerStructuredTokenKind,
  SessionComposerStructuredTokenSegment,
} from './sessionComposerStructuredTokens';

export const SESSION_COMPOSER_TOKEN_VARIANTS: Record<
  SessionComposerStructuredTokenKind,
  BadgeVariant
> = {
  slash: 'blue',
  dollar: 'green',
  file: 'cyan',
  tag: 'cyan',
  plugin_action: 'pink',
  element: 'cyan',
  agent_mention: 'purple',
  conversation: 'cyan',
  commit: 'cyan',
};

export function getSessionComposerTokenChipTitle(
  token: SessionComposerStructuredToken
): string | undefined {
  if (
    token.kind === 'agent_mention' ||
    token.kind === 'file' ||
    token.kind === 'element' ||
    token.kind === 'plugin_action' ||
    token.kind === 'conversation' ||
    token.kind === 'commit'
  ) {
    return token.title ?? token.value;
  }
  return undefined;
}

export function getSessionComposerTokenChipClassName(
  token: SessionComposerStructuredToken,
  className?: string
): string {
  return cn(
    'session-composer-token-chip inline-flex max-w-[220px] cursor-default select-none items-center gap-1 align-middle',
    (token.kind === 'file' || token.kind === 'element') &&
      'pointer-events-auto',
    token.kind === 'plugin_action' && 'mr-1',
    className
  );
}

export function SessionComposerTokenIcon({
  token,
  className = 'h-3 w-3',
}: {
  token: Pick<SessionComposerStructuredToken, 'kind' | 'value'>;
  className?: string;
}): ReactNode {
  switch (token.kind) {
    case 'slash':
      return <Command className={className} />;
    case 'dollar':
      return <Sparkles className={className} />;
    case 'plugin_action':
      return <Puzzle className={className} />;
    case 'agent_mention':
      return <AgentIcon agent={token.value} className={className} />;
    case 'file':
    case 'tag':
    case 'conversation':
    case 'commit':
    case 'element':
      return null;
  }
}

export function SessionComposerTokenChip({
  token,
  ...elementProps
}: {
  token: SessionComposerStructuredToken;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...elementProps}
      className={getSessionComposerTokenChipClassName(
        token,
        elementProps.className
      )}
      data-testid="session-composer-token-chip"
      data-token-kind={token.kind}
      data-variant={SESSION_COMPOSER_TOKEN_VARIANTS[token.kind]}
      data-structured-token-atomic="true"
      onMouseDown={(event) => event.preventDefault()}
      title={getSessionComposerTokenChipTitle(token)}
    >
      <SessionComposerTokenIcon token={token} className="h-3 w-3 shrink-0" />
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
