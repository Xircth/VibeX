import {
  forwardRef,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BadgeVariant } from '@astryxdesign/core/Badge';
import {
  Bot,
  Command,
  FileIcon,
  Folder,
  GitCommitHorizontal,
  Hash,
  MessageSquare,
  MousePointer2,
  Puzzle,
  Sparkles,
  TextQuote,
} from 'lucide-react';
import {
  AgentIcon,
  getBuiltInAgentIconPaths,
} from '@/components/agents/AgentIcon';
import { cn } from '@/lib/utils';
import {
  MemberMention,
  MemberMentionContent,
} from '@/features/collaboration/MemberMention';
import {
  deriveMemberBotAvatar,
  type MemberBotAvatarConfig,
} from '@/features/collaboration/MemberBotAvatar';
import { QuoteTokenPreview } from './QuoteTokenPreview';
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
  file: 'blue',
  tag: 'blue',
  plugin_action: 'pink',
  element: 'blue',
  agent_mention: 'purple',
  member_mention: 'blue',
  conversation: 'blue',
  commit: 'blue',
  project: 'blue',
  quote: 'blue',
};

export function getSessionComposerTokenChipTitle(
  token: SessionComposerStructuredToken
): string | undefined {
  if (token.kind === 'element' || token.kind === 'quote') {
    return undefined;
  }
  if (
    token.kind === 'agent_mention' ||
    token.kind === 'file' ||
    token.kind === 'plugin_action' ||
    token.kind === 'conversation' ||
    token.kind === 'commit' ||
    token.kind === 'project'
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
    (token.kind === 'file' ||
      token.kind === 'element' ||
      token.kind === 'quote') &&
      'pointer-events-auto',
    token.kind === 'quote' && 'cursor-help',
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
    case 'member_mention':
      return <Bot className={className} />;
    case 'file':
      return <FileIcon className={className} />;
    case 'tag':
      return <Hash className={className} />;
    case 'conversation':
      return <MessageSquare className={className} />;
    case 'commit':
      return <GitCommitHorizontal className={className} />;
    case 'project':
      return <Folder className={className} />;
    case 'element':
      return <MousePointer2 className={className} />;
    case 'quote':
      return <TextQuote className={className} />;
  }
}

export function toSessionComposerChatToken(
  token: SessionComposerStructuredToken
): {
  value: string;
  label: string;
  variant: BadgeVariant;
  icon: ReactNode;
} {
  return {
    value: token.raw,
    label: token.label,
    variant: SESSION_COMPOSER_TOKEN_VARIANTS[token.kind],
    icon: <SessionComposerTokenIcon token={token} />,
  };
}

function restoredSessionComposerTokenIconMarkup(
  token: SessionComposerStructuredToken
): string {
  if (token.kind === 'agent_mention') {
    const paths = getBuiltInAgentIconPaths(token.value);
    if (paths) {
      return renderToStaticMarkup(
        <>
          <img
            alt=""
            className="h-3 w-3 shrink-0 dark:hidden"
            src={paths.light}
          />
          <img
            alt=""
            className="h-3 w-3 shrink-0 hidden dark:block"
            src={paths.dark}
          />
        </>
      );
    }
    return renderToStaticMarkup(<Bot className="h-3 w-3 shrink-0" />);
  }

  return renderToStaticMarkup(
    <SessionComposerTokenIcon token={token} className="h-3 w-3 shrink-0" />
  );
}

export function memberMentionTokenAvatar(
  token: SessionComposerStructuredToken
): MemberBotAvatarConfig {
  return (
    (token.avatar as MemberBotAvatarConfig | undefined) ??
    deriveMemberBotAvatar(token.label || 'bot')
  );
}

export function appendSessionComposerTokenContents(
  element: HTMLElement,
  token: SessionComposerStructuredToken
) {
  element.replaceChildren();
  if (token.kind === 'member_mention') {
    element.classList.add('member-mention', 'member-mention--composer');
    element.setAttribute('data-member-mention', token.label);
    element.innerHTML = renderToStaticMarkup(
      <MemberMentionContent
        nickname={token.label}
        avatar={memberMentionTokenAvatar(token)}
      />
    );
    return;
  }
  const iconMarkup = restoredSessionComposerTokenIconMarkup(token);
  if (iconMarkup) {
    const iconHost = document.createElement('span');
    iconHost.setAttribute('aria-hidden', 'true');
    iconHost.className = 'session-composer-token-icon inline-flex shrink-0';
    iconHost.innerHTML = iconMarkup;
    element.append(iconHost);
  }
  const label = document.createElement('span');
  label.className = 'session-composer-token-label truncate font-medium';
  label.textContent = token.label;
  element.append(label);
}

export function SessionComposerTokenChip({
  token,
  ...elementProps
}: {
  token: SessionComposerStructuredToken;
} & HTMLAttributes<HTMLSpanElement>) {
  const chipRef = useRef<HTMLSpanElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [quotePreviewOpen, setQuotePreviewOpen] = useState(false);
  const isQuote = token.kind === 'quote';
  const isMemberMention = token.kind === 'member_mention';
  const showsPreview = isQuote || token.kind === 'element';

  const showQuotePreview = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setQuotePreviewOpen(true);
  };

  const hideQuotePreview = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => {
      setQuotePreviewOpen(false);
      hideTimerRef.current = null;
    }, 120);
  };

  if (isMemberMention) {
    return (
      <MemberMention
        nickname={token.label}
        avatar={memberMentionTokenAvatar(token)}
        className={elementProps.className}
      />
    );
  }

  return (
    <>
      <span
        {...elementProps}
        ref={chipRef}
        className={getSessionComposerTokenChipClassName(
          token,
          elementProps.className
        )}
        data-testid="session-composer-token-chip"
        data-token-kind={token.kind}
        data-variant={SESSION_COMPOSER_TOKEN_VARIANTS[token.kind]}
        data-structured-token-atomic="true"
        tabIndex={showsPreview ? 0 : elementProps.tabIndex}
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={showsPreview ? showQuotePreview : undefined}
        onPointerLeave={showsPreview ? hideQuotePreview : undefined}
        onFocus={showsPreview ? showQuotePreview : undefined}
        onBlur={showsPreview ? hideQuotePreview : undefined}
        title={
          showsPreview ? undefined : getSessionComposerTokenChipTitle(token)
        }
      >
        <SessionComposerTokenIcon token={token} className="h-3 w-3 shrink-0" />
        <span className="truncate font-medium">{token.label}</span>
      </span>
      {showsPreview && quotePreviewOpen && chipRef.current ? (
        <QuoteTokenPreview
          anchor={chipRef.current}
          text={isQuote ? token.value : token.label}
          onPointerEnter={showQuotePreview}
          onPointerLeave={hideQuotePreview}
        />
      ) : null}
    </>
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
