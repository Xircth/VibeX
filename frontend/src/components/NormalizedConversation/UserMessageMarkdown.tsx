import { memo, useMemo, type ReactNode } from 'react';
import {
  Markdown,
  type MarkdownInlinePlugin,
  type MarkdownProps,
} from '@astryxdesign/core/Markdown';
import {
  getSessionComposerStructuredTokenSegments,
  type SessionComposerStructuredToken,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import { SessionComposerTokenChip } from '@/components/tasks/follow-up/SessionComposerStructuredText';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  MEMBER_PLACEHOLDER_PATTERN,
  MemberMentionChip,
  protectMemberMentions,
  useCollaborationMemberMention,
} from '@/features/collaboration/MemberMentionChip';
import { applySoftBreaks } from '@/lib/conversation-rendering/streamdownPlugins';
import {
  deriveRelativeFilePath,
  resolveFilePathFromRoot,
} from '@/utils/filePaths';
import {
  MarkdownResourceLink,
  resolveMarkdownInlineResource,
} from './MarkdownResourceLink';

const TOKEN_PLACEHOLDER_PATTERN = /\uE100TOKEN(\d+)\uE100/g;
const UNDERLINE_PLACEHOLDER_PATTERN = /\uE100UNDERLINE(\d+)\uE100/g;
const LINK_PLACEHOLDER_PATTERN = /\uE100LINK(\d+)\uE100/g;
const COMMIT_CHANGES_INSTRUCTION_COMMAND = '#commit_changes';

type RestrictedLink = {
  label: string;
  href: string;
};

type RestrictedMarkdown = {
  value: string;
  tokens: SessionComposerStructuredToken[];
  underlines: string[];
  links: RestrictedLink[];
  memberMentions: string[];
};

function escapeUnsupportedInline(value: string): string {
  let result = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character === '\\' && index + 1 < value.length) {
      result += value.slice(index, index + 2);
      index += 1;
      continue;
    }

    if (character === '*') {
      let runLength = 1;
      while (value[index + runLength] === '*') runLength += 1;
      result += runLength === 2 ? '**' : '\\*'.repeat(runLength);
      index += runLength - 1;
      continue;
    }

    if ('_~[]<>|'.includes(character)) {
      result += `\\${character}`;
      continue;
    }

    result += character;
  }

  return result;
}

function replaceUnderlines(value: string, underlines: string[]): string {
  return value.replace(/__([^_\n]+?)__/g, (_match, content: string) => {
    const index = underlines.length;
    underlines.push(content);
    return `\uE100UNDERLINE${index}\uE100`;
  });
}

function replaceUserMessageLinks(
  value: string,
  links: RestrictedLink[]
): string {
  return value.replace(
    /(?<!!)\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g,
    (_match, label: string, href: string) => {
      const index = links.length;
      links.push({ label, href });
      return `\uE100LINK${index}\uE100`;
    }
  );
}

function transformPlainText(
  value: string,
  underlines: string[],
  links: RestrictedLink[]
): string {
  return escapeUnsupportedInline(
    replaceUnderlines(replaceUserMessageLinks(value, links), underlines)
  );
}

function transformInlineSyntax(
  value: string,
  underlines: string[],
  links: RestrictedLink[]
): string {
  let result = '';
  let cursor = 0;

  while (cursor < value.length) {
    const opening = value.indexOf('`', cursor);
    if (opening < 0) {
      result += transformPlainText(value.slice(cursor), underlines, links);
      break;
    }

    result += transformPlainText(
      value.slice(cursor, opening),
      underlines,
      links
    );
    const run = value.slice(opening).match(/^`+/)?.[0] ?? '`';
    const closing = value.indexOf(run, opening + run.length);
    if (closing < 0) {
      result += transformPlainText(value.slice(opening), underlines, links);
      break;
    }

    result += value.slice(opening, closing + run.length);
    cursor = closing + run.length;
  }

  return result;
}

function escapeUnsupportedBlockPrefix(value: string): string {
  if (/^\s{0,3}#{1,6}\s/u.test(value)) {
    return value.replace(/^(\s{0,3})#/u, '$1\\#');
  }
  if (/^\s{0,3}>/u.test(value)) {
    return value.replace(/^(\s{0,3})>/u, '$1\\>');
  }
  if (isThematicBreak(value)) {
    return value.replace(/^(\s{0,3})([-*_])/u, '$1\\$2');
  }
  return value;
}

const ORDERED_MARKER = String.raw`\d+(?:[.)]|\uFF0E|\uFF09|\u3001)`;
const LIST_MARKER = String.raw`(?:[-+*]|${ORDERED_MARKER})`;
const LIST_ITEM_LINE = new RegExp(
  `^[ \\t]{0,3}${LIST_MARKER}[ \\t\\u00A0\\u3000]+\\S`,
  'u'
);

function isThematicBreak(value: string): boolean {
  return /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/u.test(value);
}

function isUserListItemLine(line: string): boolean {
  return !isThematicBreak(line) && LIST_ITEM_LINE.test(line);
}

function canonicalizeOrderedMarker(marker: string): string {
  return marker.replace(/[\uFF0E\u3001]$/u, '.').replace(/\uFF09$/u, ')');
}

/** Turn composer spaces and CJK markers into a marker the markdown parser accepts. */
function normalizeUserListLine(line: string): string {
  const match = line.match(
    new RegExp(
      `^([ \\t]{0,3})(${LIST_MARKER})([ \\t\\u00A0\\u3000]*)(.*)$`,
      'u'
    )
  );
  if (!match || isThematicBreak(line)) return line;

  const indent = match[1] ?? '';
  const rawMarker = match[2] ?? '';
  const gap = match[3] ?? '';
  const rest = match[4] ?? '';
  const ordered = /^\d/u.test(rawMarker);
  const marker = ordered ? canonicalizeOrderedMarker(rawMarker) : rawMarker;

  if (gap.length === 0) {
    if (!ordered || rest.length === 0 || /^[\d.)]/u.test(rest)) return line;
    return `${indent}${marker} ${rest}`;
  }
  if (gap === ' ' && marker === rawMarker) return line;
  return `${indent}${marker} ${rest}`;
}

function loosenOrderedMarkers(line: string): string {
  const markerBody = new RegExp(
    `(${ORDERED_MARKER})(?=[^\\d\\s.)\\uFF0E])`,
    'gu'
  );
  const candidates = [...line.matchAll(markerBody)];
  if (candidates.length === 0) return line;

  const rewrite = (_full: string, prefix: string, marker: string) =>
    `${prefix}${canonicalizeOrderedMarker(marker)} `;

  const lineStart = new RegExp(
    `^([ \\t]{0,3})(${ORDERED_MARKER})(?=[^\\d\\s.)\\uFF0E])`,
    'u'
  );
  const next = line.replace(lineStart, rewrite);
  if (candidates.length < 2) return next;

  return next.replace(
    new RegExp(
      `(?<=[^\\dA-Za-z\\s])(${ORDERED_MARKER})(?=[^\\d\\s.)\\uFF0E])`,
      'gu'
    ),
    (_full, marker: string) => `${canonicalizeOrderedMarker(marker)} `
  );
}

function splitGluedOrderedItems(line: string): string[] {
  if (isThematicBreak(line)) return [line];
  const found = [
    ...line.matchAll(new RegExp(`${ORDERED_MARKER}[ \\t]+[^\\d\\s]`, 'gu')),
  ];
  if (found.length < 2) return [line];

  const breaks: number[] = [];
  for (const match of found) {
    const index = match.index ?? 0;
    if (index === 0) continue;
    const previous = line[index - 1] ?? '';
    if (previous && !/[\dA-Za-z\s]/u.test(previous)) breaks.push(index);
  }
  if (breaks.length === 0) return [line];

  const parts: string[] = [];
  let cursor = 0;
  for (const index of breaks) {
    parts.push(line.slice(cursor, index).replace(/[ \t]+$/u, ''));
    cursor = index;
  }
  parts.push(line.slice(cursor));
  return parts;
}

function peelTrailingListItem(line: string, nextIsList: boolean): string[] {
  if (!nextIsList || isUserListItemLine(line) || isThematicBreak(line)) {
    return [line];
  }
  const match = line.match(
    new RegExp(
      `^(.*[^\\dA-Za-z\\s])[ \\t]*(${LIST_MARKER}[ \\t]+[^\\d\\s].*)$`,
      'u'
    )
  );
  if (!match?.[1] || !match[2]) return [line];
  return [match[1].replace(/[ \t]+$/u, ''), match[2]];
}

function inListContext(lines: readonly string[]): boolean {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') return false;
    if (isUserListItemLine(line)) return true;
  }
  return false;
}

/**
 * A single newline is not enough for every list the composer produces.
 * CommonMark keeps a `2.` / `3.` line inside the previous paragraph, and a
 * non-breaking space after the marker never counts as the required gap, so
 * the newline collapses into the sentence. A blank line before the list makes
 * the following items render as a list.
 */
function promoteUserMessageLists(value: string): string {
  const sourceLines = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .split('\n');
  const normalized: string[] = [];
  let inCodeFence = false;

  for (const sourceLine of sourceLines) {
    if (/^[ \t]{0,3}```/u.test(sourceLine)) {
      inCodeFence = !inCodeFence;
      normalized.push(sourceLine);
      continue;
    }
    if (inCodeFence) {
      normalized.push(sourceLine);
      continue;
    }
    normalized.push(
      ...splitGluedOrderedItems(loosenOrderedMarkers(sourceLine)).map(
        normalizeUserListLine
      )
    );
  }

  const promoted: string[] = [];
  inCodeFence = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const line = normalized[index] ?? '';
    if (/^[ \t]{0,3}```/u.test(line)) {
      inCodeFence = !inCodeFence;
      promoted.push(line);
      continue;
    }
    if (inCodeFence) {
      promoted.push(line);
      continue;
    }

    const next = normalized[index + 1];
    const pieces = peelTrailingListItem(
      line,
      next != null && isUserListItemLine(next)
    );
    for (const piece of pieces) {
      if (
        isUserListItemLine(piece) &&
        promoted.length > 0 &&
        (promoted[promoted.length - 1] ?? '').trim() !== '' &&
        !inListContext(promoted)
      ) {
        promoted.push('');
      }
      promoted.push(piece);
    }
  }

  return promoted.join('\n');
}

function prepareUserMessageMarkdown(
  source: string,
  enableMemberMentions = false,
  knownNicknames: readonly string[] = []
): RestrictedMarkdown {
  const tokens: SessionComposerStructuredToken[] = [];
  const underlines: string[] = [];
  const links: RestrictedLink[] = [];
  let inCodeFence = false;
  const sourceWithTokenPlaceholders = getSessionComposerStructuredTokenSegments(
    source,
    {
      includeLegacyTokens: source === COMMIT_CHANGES_INSTRUCTION_COMMAND,
    }
  )
    .map((segment) => {
      if (segment.kind === 'text') return segment.text;
      const index = tokens.length;
      tokens.push(segment.token);
      return `\uE100TOKEN${index}\uE100`;
    })
    .join('');

  const protectedMentions = enableMemberMentions
    ? protectMemberMentions(sourceWithTokenPlaceholders, knownNicknames)
    : { text: sourceWithTokenPlaceholders, mentions: [] };

  const value = promoteUserMessageLists(protectedMentions.text)
    .split('\n')
    .map((line) => {
      if (/^\s*```/u.test(line)) {
        inCodeFence = !inCodeFence;
        return line;
      }
      if (inCodeFence) return line;

      const listMatch = line.match(/^(\s{0,3}(?:[-+*]|\d+[.)])\s+)([\s\S]*)$/u);
      if (listMatch) {
        return `${listMatch[1]}${transformInlineSyntax(
          listMatch[2],
          underlines,
          links
        )}`;
      }

      return transformInlineSyntax(
        escapeUnsupportedBlockPrefix(line),
        underlines,
        links
      );
    })
    .join('\n');

  return {
    value: applySoftBreaks(value),
    tokens,
    underlines,
    links,
    memberMentions: protectedMentions.mentions,
  };
}

function UserCodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  return (
    <pre className="user-message-code-block" data-language={language}>
      <code>{code}</code>
    </pre>
  );
}

export type UserMessageMarkdownProps = {
  value: string;
  className?: string;
  workspacePath?: string | null;
};

export const UserMessageMarkdown = memo(function UserMessageMarkdown({
  value,
  className,
  workspacePath,
}: UserMessageMarkdownProps) {
  const panelActions = useOptionalPanelActionsContext();
  const memberMentionCtx = useCollaborationMemberMention();
  const restricted = useMemo(
    () =>
      prepareUserMessageMarkdown(
        value,
        memberMentionCtx.enableMemberMentions,
        memberMentionCtx.knownNicknames
      ),
    [
      memberMentionCtx.enableMemberMentions,
      memberMentionCtx.knownNicknames,
      value,
    ]
  );
  const inlinePlugins = useMemo<MarkdownInlinePlugin[]>(
    () => [
      {
        pattern: TOKEN_PLACEHOLDER_PATTERN,
        render: (match, key): ReactNode => {
          const token = restricted.tokens[Number(match[1])];
          if (!token) return null;
          if (token.kind === 'file' && panelActions) {
            return (
              <SessionComposerTokenChip
                key={key}
                token={token}
                className="cursor-pointer"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const fullPath = resolveFilePathFromRoot(
                    token.value,
                    workspacePath
                  );
                  const displayPath =
                    deriveRelativeFilePath(fullPath, workspacePath) ??
                    token.value;
                  panelActions.openFilePreview(fullPath, {
                    displayPath,
                    title: displayPath,
                  });
                }}
              />
            );
          }
          return <SessionComposerTokenChip key={key} token={token} />;
        },
      },
      {
        pattern: UNDERLINE_PLACEHOLDER_PATTERN,
        render: (match, key): ReactNode => (
          <u key={key}>{restricted.underlines[Number(match[1])] ?? ''}</u>
        ),
      },
      {
        pattern: LINK_PLACEHOLDER_PATTERN,
        render: (match, key): ReactNode => {
          const link = restricted.links[Number(match[1])];
          return link ? (
            <MarkdownResourceLink
              key={key}
              href={link.href}
              workspacePath={workspacePath}
            >
              {link.label}
            </MarkdownResourceLink>
          ) : null;
        },
      },
      {
        pattern: MEMBER_PLACEHOLDER_PATTERN,
        render: (match, key): ReactNode => {
          const nickname = restricted.memberMentions[Number(match[1])];
          if (!nickname) return null;
          return (
            <MemberMentionChip
              key={key}
              nickname={nickname}
              avatar={memberMentionCtx.resolveMemberAvatar(nickname)}
            />
          );
        },
      },
    ],
    [
      memberMentionCtx,
      panelActions,
      restricted.links,
      restricted.memberMentions,
      restricted.tokens,
      restricted.underlines,
      workspacePath,
    ]
  );
  const components = useMemo<MarkdownProps['components']>(
    () => ({
      code: UserCodeBlock,
      inlineCode: ({ children }) => {
        const text = String(children).trim();
        const resource = resolveMarkdownInlineResource(text, workspacePath);

        if (resource) {
          return (
            <MarkdownResourceLink
              href={resource.href}
              pathTarget={resource.pathTarget}
              workspacePath={workspacePath}
            >
              {text || children}
            </MarkdownResourceLink>
          );
        }

        return <code>{text || children}</code>;
      },
      link: ({ href, children }) => (
        <MarkdownResourceLink href={href} workspacePath={workspacePath}>
          {children}
        </MarkdownResourceLink>
      ),
    }),
    [workspacePath]
  );

  return (
    <div
      className={`conv-markdown conv-user-markdown${className ? ` ${className}` : ''}`}
    >
      <Markdown
        autolink="gfm"
        display="block"
        contentWidth="100%"
        components={components}
        inlinePlugins={inlinePlugins}
      >
        {restricted.value}
      </Markdown>
    </div>
  );
});
