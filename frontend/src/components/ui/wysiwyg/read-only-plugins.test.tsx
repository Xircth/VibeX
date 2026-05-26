import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./plugins/read-only-link-plugin', () => ({
  ReadOnlyLinkPlugin: () => <div data-testid="read-only-link-plugin" />,
}));

vi.mock('./plugins/clickable-code-plugin', () => ({
  ClickableCodePlugin: ({
    findMatchingDiffPath,
    onCodeClick,
  }: {
    findMatchingDiffPath: (text: string) => string | null;
    onCodeClick: (fullPath: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        const match = findMatchingDiffPath('src/App.tsx');
        if (match) {
          onCodeClick(match);
        }
      }}
    >
      clickable-code-plugin
    </button>
  ),
}));

import { WysiwygReadOnlyPlugins } from './read-only-plugins';

describe('WysiwygReadOnlyPlugins', () => {
  it('always renders link sanitization', () => {
    render(<WysiwygReadOnlyPlugins />);

    expect(screen.getByTestId('read-only-link-plugin')).toBeInTheDocument();
  });

  it('requires both clickable code callbacks before rendering clickable code', () => {
    const findMatchingDiffPath = vi.fn(() => 'src/App.tsx');
    const onCodeClick = vi.fn();

    const { rerender } = render(
      <WysiwygReadOnlyPlugins findMatchingDiffPath={findMatchingDiffPath} />
    );

    expect(
      screen.queryByRole('button', { name: 'clickable-code-plugin' })
    ).toBeNull();

    rerender(<WysiwygReadOnlyPlugins onCodeClick={onCodeClick} />);

    expect(
      screen.queryByRole('button', { name: 'clickable-code-plugin' })
    ).toBeNull();
  });

  it('passes clickable code callbacks through when both are provided', () => {
    const findMatchingDiffPath = vi.fn(() => 'src/App.tsx');
    const onCodeClick = vi.fn();

    render(
      <WysiwygReadOnlyPlugins
        findMatchingDiffPath={findMatchingDiffPath}
        onCodeClick={onCodeClick}
      />
    );

    screen.getByRole('button', { name: 'clickable-code-plugin' }).click();

    expect(findMatchingDiffPath).toHaveBeenCalledWith('src/App.tsx');
    expect(onCodeClick).toHaveBeenCalledWith('src/App.tsx');
  });
});
