import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatSessionComposerCommand } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import { UserMessageMarkdown } from './UserMessageMarkdown';

const userMessageStyles = [
  readFileSync(
    resolve(process.cwd(), 'src/styles/conversation/conv-variables.css'),
    'utf8'
  ),
  readFileSync(
    resolve(process.cwd(), 'src/styles/conversation/conv-markdown.css'),
    'utf8'
  ),
  readFileSync(
    resolve(process.cwd(), 'src/styles/conversation/conv-messages.css'),
    'utf8'
  ),
].join('\n');

function StyledUserMessage({
  dark = false,
  value,
  workspacePath,
}: {
  dark?: boolean;
  value: string;
  workspacePath?: string;
}) {
  return (
    <div className={`legacy-design${dark ? ' dark' : ''}`}>
      <style>{userMessageStyles}</style>
      <div className="vibex-user-message">
        <div className="conv-user-bubble" data-testid="styled-user-bubble">
          <UserMessageMarkdown value={value} workspacePath={workspacePath} />
        </div>
      </div>
    </div>
  );
}

describe('UserMessageMarkdown', () => {
  it('renders a legacy path-backed skill token with its short command label', () => {
    render(
      <UserMessageMarkdown
        value={formatSessionComposerCommand({
          type: '/',
          key: 'skill:/Users/mac/.codex/skills/drawio/drawio',
          value: '/drawio',
        })}
      />
    );

    const tokenChip = screen
      .getByText('/drawio')
      .closest('[data-testid="session-composer-token-chip"]');

    expect(tokenChip).toBeInTheDocument();
    expect(tokenChip).not.toHaveTextContent('/Users/mac');
  });

  it('renders the automatic commit instruction as a structured token', () => {
    render(<UserMessageMarkdown value="#commit_changes" />);

    const tokenChip = screen
      .getByText('#commit_changes')
      .closest('[data-testid="session-composer-token-chip"]');

    expect(tokenChip).toHaveAttribute('data-token-kind', 'tag');
    expect(tokenChip?.querySelector('svg')).toBeNull();
  });

  it('uses legible adaptive colors for every prose node', () => {
    const { rerender } = render(
      <StyledUserMessage value="Plain **bold** message" />
    );

    const bubble = screen.getByTestId('styled-user-bubble');
    const paragraph = screen.getByRole('paragraph');
    const theme = bubble.closest('.legacy-design') as Element;
    expect(getComputedStyle(theme).getPropertyValue('--conv-user-bg')).toBe(
      '#f3f3f4'
    );
    expect(getComputedStyle(theme).getPropertyValue('--conv-user-text')).toBe(
      '#000'
    );
    expect(getComputedStyle(paragraph).color).toBe('var(--conv-user-text)');

    rerender(<StyledUserMessage dark value="Plain **bold** message" />);

    expect(getComputedStyle(theme).getPropertyValue('--conv-user-bg')).toBe(
      '#242424'
    );
    expect(getComputedStyle(theme).getPropertyValue('--conv-user-text')).toBe(
      '#fff'
    );
    expect(getComputedStyle(paragraph).color).toBe('var(--conv-user-text)');
  });

  it('reduces the user-message list indentation by eighty percent', () => {
    render(<StyledUserMessage value={'- Parent\n  - Child'} />);

    const list = screen.getAllByRole('list')[0];
    const item = list.querySelector(':scope > li');
    const marker = item?.querySelector(':scope > span:first-child');

    expect(getComputedStyle(list).paddingInlineStart).toBe('0.05rem');
    expect(getComputedStyle(item as Element).paddingInlineStart).toBe('0px');
    expect(getComputedStyle(item as Element).gap).toBe('0.125rem');
    expect(getComputedStyle(marker as Element).width).toBe('0.5rem');
  });

  it('keeps user-message ordered-list numbers on one line', () => {
    render(<StyledUserMessage value={'1. first\n2. second'} />);

    const ordered = screen
      .getAllByRole('list')
      .find((list) => list.tagName === 'OL');
    const marker = ordered?.querySelector(':scope > li > span:first-child');
    const style = getComputedStyle(marker as Element);

    expect(style.whiteSpace).toBe('nowrap');
    expect(style.minWidth).toBe('1.5em');
  });

  it('renders file and website links with the shared inline resource style', () => {
    render(
      <StyledUserMessage
        workspacePath="C:/workspace/project"
        value={'[App](frontend/src/App.tsx) and https://example.com/docs'}
      />
    );

    const fileLink = screen.getByRole('link', { name: 'App' });
    expect(fileLink).toHaveClass('conv-resource-link');
    expect(fileLink).toHaveAttribute('data-resource-kind', 'file');
    expect(
      fileLink.querySelector('[data-resource-icon="file"] svg')
    ).toBeInTheDocument();

    const webLink = screen.getByRole('link', {
      name: 'https://example.com/docs',
    });
    expect(webLink).toHaveClass('conv-resource-link');
    expect(webLink).toHaveAttribute('data-resource-kind', 'web');
    expect(webLink.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/favicon.ico'
    );
  });

  it('renders only the user-message Markdown allowlist', () => {
    const slashCommand = formatSessionComposerCommand({
      type: '/',
      key: 'review',
      value: '/review',
    });

    const { container } = render(
      <UserMessageMarkdown
        value={[
          '# Plain heading syntax',
          '',
          `Use ${slashCommand}, **bold**, __underlined__, and \`inline code\`.`,
          '',
          '- first bullet',
          '- [x] plain task syntax',
          '  - nested bullet',
          '',
          '1. first step',
          '2. second step',
          '',
          '```ts',
          'const answer = 42;',
          '```',
          '',
          '*italic* ~~strike~~ [link](https://example.com)',
          '> quote',
          '<u>html</u>',
          '| table | syntax |',
          '| --- | --- |',
        ].join('\n')}
      />
    );

    expect(
      screen.getByText('/review').closest('[data-structured-token-atomic]')
    ).toHaveAttribute('data-structured-token-atomic', 'true');
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('underlined').tagName).toBe('U');
    expect(screen.getByText('inline code').tagName).toBe('CODE');
    expect(screen.getByText('const answer = 42;').tagName).toBe('CODE');
    expect(container.querySelectorAll('ul')).toHaveLength(2);
    expect(container.querySelectorAll('ol')).toHaveLength(1);

    expect(container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(
      container.querySelector(
        'em, del, img:not(.conv-resource-link-favicon), input, blockquote, table'
      )
    ).toBeNull();
    expect(screen.getByRole('link', { name: 'link' })).toHaveClass(
      'conv-resource-link'
    );
    expect(container).toHaveTextContent('# Plain heading syntax');
    expect(container).toHaveTextContent('*italic*');
    expect(container).toHaveTextContent('~~strike~~');
    expect(container).toHaveTextContent('link');
    expect(container).toHaveTextContent('> quote');
    expect(container).toHaveTextContent('<u>html</u>');
    expect(container).toHaveTextContent('| table | syntax |');
  });
});
