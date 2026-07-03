import { render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './Markdown';

const markdownRenderCounts = vi.hoisted(() => new Map<string, number>());

vi.mock('react-markdown', async () => {
  const actual =
    await vi.importActual<typeof import('react-markdown')>('react-markdown');
  const ActualMarkdown = actual.default;

  function CountingMarkdown(props: ComponentProps<typeof ActualMarkdown>) {
    const key = String(props.children ?? '');
    markdownRenderCounts.set(key, (markdownRenderCounts.get(key) ?? 0) + 1);
    return <ActualMarkdown {...props} />;
  }

  return { ...actual, default: CountingMarkdown };
});

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => null,
}));

describe('Markdown block-level memoization', () => {
  beforeEach(() => {
    markdownRenderCounts.clear();
  });

  it('renders each top-level block as a direct child of .conv-markdown', () => {
    const { container } = render(
      <Markdown value={'first paragraph\n\nsecond paragraph'} />
    );

    const wrapper = container.querySelector('.conv-markdown');
    expect(wrapper).not.toBeNull();
    const children = Array.from(wrapper!.children);
    expect(children.map((child) => child.tagName)).toEqual(['P', 'P']);
    expect(children[0]).toHaveTextContent('first paragraph');
    expect(children[1]).toHaveTextContent('second paragraph');
  });

  it('does not re-parse completed blocks while the tail block grows', () => {
    const firstBlock = 'first paragraph\n\n';
    const { rerender } = render(
      <Markdown value={`${firstBlock}second par`} />
    );

    rerender(<Markdown value={`${firstBlock}second paragraph grows`} />);
    rerender(<Markdown value={`${firstBlock}second paragraph grows more`} />);

    expect(markdownRenderCounts.get(firstBlock)).toBe(1);
    expect(markdownRenderCounts.get('second par')).toBe(1);
    expect(markdownRenderCounts.get('second paragraph grows')).toBe(1);
    expect(markdownRenderCounts.get('second paragraph grows more')).toBe(1);
  });

  it('re-parses only newly completed and growing blocks as more blocks stream in', () => {
    const { rerender } = render(<Markdown value={'alpha'} />);
    rerender(<Markdown value={'alpha\n\nbeta'} />);
    rerender(<Markdown value={'alpha\n\nbeta\n\ngamma'} />);

    expect(markdownRenderCounts.get('alpha')).toBe(1);
    expect(markdownRenderCounts.get('alpha\n\n')).toBe(1);
    expect(markdownRenderCounts.get('beta')).toBe(1);
    expect(markdownRenderCounts.get('beta\n\n')).toBe(1);
    expect(markdownRenderCounts.get('gamma')).toBe(1);
  });
});
