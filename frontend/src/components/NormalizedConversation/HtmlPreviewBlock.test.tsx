import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  HtmlPreviewBlock,
  isHtmlPreviewLanguage,
  wrapHtmlPreviewDocument,
} from './HtmlPreviewBlock';

vi.mock('./CodeBlock', () => ({
  CodeBlock: ({ value }: { value: string }) => (
    <pre data-testid="html-source">{value}</pre>
  ),
}));

describe('HtmlPreviewBlock', () => {
  it('treats html and htm fences as preview languages', () => {
    expect(isHtmlPreviewLanguage('html')).toBe(true);
    expect(isHtmlPreviewLanguage('HTM')).toBe(true);
    expect(isHtmlPreviewLanguage('javascript')).toBe(false);
  });

  it('wraps snippets and keeps complete documents', () => {
    expect(wrapHtmlPreviewDocument('<h1>Hi</h1>')).toContain('<h1>Hi</h1>');
    expect(wrapHtmlPreviewDocument('<h1>Hi</h1>')).toContain('<!DOCTYPE html>');
    expect(
      wrapHtmlPreviewDocument('<!DOCTYPE html><html><body>ok</body></html>')
    ).toBe('<!DOCTYPE html><html><body>ok</body></html>');
  });

  it('renders a sandboxed preview iframe and opens context menu actions on right click', () => {
    render(<HtmlPreviewBlock code="<p>hello preview</p>" />);

    const container = screen.getByTestId('standalone-html-preview');
    expect(container).toHaveAttribute('data-expanded', 'false');

    const frame = screen.getByTitle('HTML 预览');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-modals allow-popups'
    );
    expect(frame).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('<p>hello preview</p>')
    );

    fireEvent.contextMenu(container);
    expect(screen.getByTestId('html-preview-context-menu')).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '在标签页打开' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: '复制绝对路径' })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: '展开' }));
    expect(container).toHaveAttribute('data-expanded', 'true');
    expect(screen.queryByTestId('html-preview-context-menu')).toBeNull();
  });
});
