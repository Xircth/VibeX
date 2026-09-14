import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blobSrcFromDataUrl,
  hostFileSrc,
  isBrowserDisplayUrl,
  isDirectBrowserDisplayUrl,
} from './hostAsset';

const backendCall = vi.hoisted(() => vi.fn());

vi.mock('@/lib/backendTransport', () => ({
  backendCall,
}));

describe('hostFileSrc', () => {
  beforeEach(() => {
    backendCall.mockReset();
    vi.stubGlobal(
      'URL',
      class {
        static createObjectURL(blob: Blob) {
          return `blob:${blob.type || 'empty'}`;
        }
        static revokeObjectURL() {}
      }
    );
  });

  it('creates a typed blob so WKWebView can render the image', async () => {
    backendCall.mockResolvedValue({
      data_base64: btoa('png-bytes'),
      mime_type: 'image/png',
    });

    await expect(hostFileSrc('/tmp/shot.png')).resolves.toBe('blob:image/png');
    expect(backendCall).toHaveBeenCalledWith('read_binary_asset', {
      path: '/tmp/shot.png',
    });
  });

  it('falls back to the path extension when the asset omits mime type', async () => {
    backendCall.mockResolvedValue({
      data_base64: btoa('jpg-bytes'),
    });

    await expect(hostFileSrc('/tmp/photo.jpg')).resolves.toBe(
      'blob:image/jpeg'
    );
  });
});

describe('isBrowserDisplayUrl', () => {
  it('rejects filesystem paths that cannot be used as img src', () => {
    expect(isBrowserDisplayUrl('blob:abc')).toBe(true);
    expect(isBrowserDisplayUrl('data:image/png;base64,AA')).toBe(true);
    expect(isBrowserDisplayUrl('asset://localhost/shot.png')).toBe(true);
    expect(isBrowserDisplayUrl('/Users/mac/shot.png')).toBe(false);
    expect(isBrowserDisplayUrl('.vibe-images/shot.png')).toBe(false);
  });

  it('keeps data URLs out of direct img src so WKWebView can render blobs', () => {
    expect(isDirectBrowserDisplayUrl('blob:abc')).toBe(true);
    expect(isDirectBrowserDisplayUrl('asset://localhost/shot.png')).toBe(true);
    expect(isDirectBrowserDisplayUrl('data:image/png;base64,AA')).toBe(false);
    expect(isDirectBrowserDisplayUrl('/tmp/shot.png')).toBe(false);
  });
});

describe('blobSrcFromDataUrl', () => {
  it('converts a data URL into a typed blob URL', () => {
    const url = blobSrcFromDataUrl(
      `data:image/png;base64,${btoa('png-bytes')}`
    );
    expect(url).toBe('blob:image/png');
  });
});
