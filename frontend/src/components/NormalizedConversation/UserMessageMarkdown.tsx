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

const TOKEN_PLACEHOLDER_PATTERN = /\uE100TOKEN(\d+)\uE100/g;
const UNDERLINE_PLACEHOLDER_PATTERN = /\uE100UNDERLINE(\d+)\uE100/g;

type RestrictedMarkdown = {
  value: string;
  tokens: SessionComposerStructuredToken[];
  underlines: string[];
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

function transformPlainText(value: string, underlines: string[]): string {
  return escapeUnsupportedInline(replaceUnderlines(value, underlines));
}

function transformInlineSyntax(value: string, underlines: string[]): string {
  let result = '';
  let cursor = 0;

  while (cursor < value.length) {
    const opening = value.indexOf('`', cursor);
    if (opening < 0) {
      result += transformPlainText(value.slice(cursor), underlines);
      break;
    }

    result += transformPlainText(value.slice(cursor, opening), underlines);
    const run = value.slice(opening).match(/^`+/)?.[0] ?? '`';
    const closing = value.indexOf(run, opening + run.length);
    if (closing < 0) {
      result += transformPlainText(value.slice(opening), underlines);
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
  let inCodeFence = false;
  const sourceWithTokenPlaceholders = getSessionComposerStructuredTokenSegments(
    source
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
          underlines
        )}`;
      }

      return transformInlineSyntax(
        escapeUnsupportedBlockPrefix(line),
        underlines
      );
    })
    .join('\n');

  return { value, tokens, underlines };
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

function UserInlineCode({ children }: { children: string }) {
  return <code>{children}</code>;
}

const USER_MARKDOWN_COMPONENTS: MarkdownProps['components'] = {
  code: UserCodeBlock,
  inlineCode: UserInlineCode,
};

export type UserMessageMarkdownProps = {
  value: string;
  className?: string;
};

export const UserMessageMarkdown = memo(function UserMessageMarkdown({
  value,
  className,
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
    ],
    [restricted.tokens, restricted.underlines]
  );

  return (
    <div
      className={`conv-markdown conv-user-markdown${className ? ` ${className}` : ''}`}
    >
      <Markdown
        display="block"
        density="compact"
        contentWidth="100%"
        components={USER_MARKDOWN_COMPONENTS}
        inlinePlugins={inlinePlugins}
      >
        {restricted.value}
      </Markdown>
    </div>
  );
});
