import { describe, expect, it } from 'vitest';
import {
  getFilePreviewKind,
  isAutoPreviewPath,
  isBinaryContentError,
  isBinaryPreviewPath,
  isImagePreviewPath,
  isPdfPreviewPath,
} from './filePreviewKind';

describe('filePreviewKind', () => {
  it('classifies image preview paths', () => {
    expect(isImagePreviewPath('C:/repo/src-tauri/icons/128x128.png')).toBe(
      true
    );
    expect(getFilePreviewKind('C:/repo/src-tauri/icons/128x128.png')).toBe(
      'image'
    );
  });

  it('classifies binary preview paths', () => {
    expect(isBinaryPreviewPath('C:/repo/src-tauri/icons/icon.icns')).toBe(true);
    expect(getFilePreviewKind('C:/repo/src-tauri/icons/icon.icns')).toBe(
      'binary'
    );
  });

  it('classifies pdf paths and leaves Office rendering to plugins', () => {
    expect(isPdfPreviewPath('C:/repo/docs/spec.pdf')).toBe(true);
    expect(getFilePreviewKind('C:/repo/docs/spec.pdf')).toBe('pdf');
    expect(getFilePreviewKind('C:/repo/docs/spec.doc')).toBe('binary');
  });

  it('leaves extension ownership to plugin file opener contributions', () => {
    expect(getFilePreviewKind('C:/repo/docs/spec.docx')).toBe('binary');
    expect(getFilePreviewKind('C:/repo/docs/data.xlsx')).toBe('binary');
    expect(getFilePreviewKind('C:/repo/docs/deck.PPTX')).toBe('binary');
  });

  it('auto-opens only the files that render without an editor', () => {
    expect(isAutoPreviewPath('C:/repo/docs/page.html')).toBe(true);
    expect(isAutoPreviewPath('C:/repo/docs/page.htm')).toBe(true);
    expect(isAutoPreviewPath('C:/repo/docs/icon.SVG')).toBe(true);
    expect(isAutoPreviewPath('C:\\repo\\docs\\icon.svg')).toBe(true);
  });

  it('leaves other renderable files to the user to open', () => {
    // Images render too, but a screenshot appearing is not a reason for a tab.
    expect(isAutoPreviewPath('C:/repo/docs/shot.png')).toBe(false);
    expect(isAutoPreviewPath('C:/repo/docs/spec.pdf')).toBe(false);
    expect(isAutoPreviewPath('C:/repo/README.md')).toBe(false);
    expect(isAutoPreviewPath('C:/repo/page.html.bak')).toBe(false);
    expect(isAutoPreviewPath(null)).toBe(false);
    expect(isAutoPreviewPath(undefined)).toBe(false);
  });

  it('detects binary-content read errors', () => {
    expect(
      isBinaryContentError(
        'Internal error: Failed to read file icon.icns: stream did not contain valid UTF-8'
      )
    ).toBe(true);
    expect(
      isBinaryContentError('Bad request: Binary file cannot be opened as text')
    ).toBe(true);
    expect(isBinaryContentError('Failed to open project')).toBe(false);
  });
});
