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

  it('renders a sandboxed preview iframe and can toggle source', () => {
    render(<HtmlPreviewBlock code="<p>hello preview</p>" />);

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

    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    expect(screen.getByTestId('html-source')).toHaveTextContent(
      '<p>hello preview</p>'
    );
    expect(screen.queryByTitle('HTML 预览')).toBeNull();
  });
});
