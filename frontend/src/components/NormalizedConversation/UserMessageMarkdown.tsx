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
  if (/^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/u.test(value)) {
    return value.replace(/^(\s{0,3})([-*_])/u, '$1\\$2');
  }
  return value;
}

function prepareUserMessageMarkdown(source: string): RestrictedMarkdown {
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

  const value = sourceWithTokenPlaceholders
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

  return { value, tokens, underlines, links };
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
  const restricted = useMemo(() => prepareUserMessageMarkdown(value), [value]);
  const inlinePlugins = useMemo<MarkdownInlinePlugin[]>(
    () => [
      {
        pattern: TOKEN_PLACEHOLDER_PATTERN,
        render: (match, key): ReactNode => {
          const token = restricted.tokens[Number(match[1])];
          return token ? (
            <SessionComposerTokenChip key={key} token={token} />
          ) : null;
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
    ],
    [restricted.links, restricted.tokens, restricted.underlines, workspacePath]
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
        density="compact"
        contentWidth="100%"
        components={components}
        inlinePlugins={inlinePlugins}
      >
        {restricted.value}
      </Markdown>
    </div>
  );
});
