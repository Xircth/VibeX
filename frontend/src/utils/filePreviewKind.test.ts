import { describe, expect, it } from 'vitest';
import {
  getFilePreviewKind,
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
