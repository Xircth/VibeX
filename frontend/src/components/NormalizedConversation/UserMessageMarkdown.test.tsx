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
    resolve(process.cwd(), 'src/styles/conversation/conv-messages.css'),
    'utf8'
  ),
].join('\n');

function StyledUserMessage({
  dark = false,
  value,
}: {
  dark?: boolean;
  value: string;
}) {
  return (
    <div className={`legacy-design${dark ? ' dark' : ''}`}>
      <style>{userMessageStyles}</style>
      <div className="vibex-user-message">
        <div className="conv-user-bubble" data-testid="styled-user-bubble">
          <UserMessageMarkdown value={value} />
        </div>
      </div>
    </div>
  );
}

describe('UserMessageMarkdown', () => {
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

  it('reduces the Astryx list indentation to one quarter of the old value', () => {
    render(<StyledUserMessage value={'- Parent\n  - Child'} />);

    const list = screen.getAllByRole('list')[0];
    const item = list.querySelector(':scope > li');
    const marker = item?.querySelector(':scope > span:first-child');

    expect(getComputedStyle(list).paddingInlineStart).toBe('0.25rem');
    expect(getComputedStyle(item as Element).paddingInlineStart).toBe('0px');
    expect(getComputedStyle(item as Element).gap).toBe('0.125rem');
    expect(getComputedStyle(marker as Element).width).toBe('0.5rem');
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
      container.querySelector('em, del, a, img, input, blockquote, table')
    ).toBeNull();
    expect(container).toHaveTextContent('# Plain heading syntax');
    expect(container).toHaveTextContent('*italic*');
    expect(container).toHaveTextContent('~~strike~~');
    expect(container).toHaveTextContent('[link](https://example.com)');
    expect(container).toHaveTextContent('> quote');
    expect(container).toHaveTextContent('<u>html</u>');
    expect(container).toHaveTextContent('| table | syntax |');
  });
});
