import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blobSrcFromDataUrl,
  hostFileSrc,
  isBrowserDisplayUrl,
  isDirectBrowserDisplayUrl,
  releaseHostFileSrc,
  resetHostFileSrcCache,
} from './hostAsset';

const backendCall = vi.hoisted(() => vi.fn());

vi.mock('@/lib/backendTransport', () => ({
  backendCall,
}));

describe('hostFileSrc', () => {
  const revokeObjectURL = vi.fn();
  let nextBlobId = 0;

  beforeEach(() => {
    backendCall.mockReset();
    revokeObjectURL.mockReset();
    nextBlobId = 0;
    resetHostFileSrcCache();
    vi.stubGlobal(
      'URL',
      class {
        static createObjectURL(blob: Blob) {
          nextBlobId += 1;
          return `blob:${blob.type || 'empty'}:${nextBlobId}`;
        }
        static revokeObjectURL(url: string) {
          revokeObjectURL(url);
        }
      }
    );
  });

  afterEach(() => {
    resetHostFileSrcCache();
    vi.unstubAllGlobals();
  });

  it('creates a typed blob so WKWebView can render the image', async () => {
    backendCall.mockResolvedValue({
      data_base64: btoa('png-bytes'),
      mime_type: 'image/png',
    });

    await expect(hostFileSrc('/tmp/shot.png')).resolves.toBe(
      'blob:image/png:1'
    );
    expect(backendCall).toHaveBeenCalledWith('read_binary_asset', {
      path: '/tmp/shot.png',
    });
  });

  it('falls back to the path extension when the asset omits mime type', async () => {
    backendCall.mockResolvedValue({
      data_base64: btoa('jpg-bytes'),
    });

    await expect(hostFileSrc('/tmp/photo.jpg')).resolves.toBe(
      'blob:image/jpeg:1'
    );
  });

  it('reuses one blob while retainers are active and revokes on the last release', async () => {
    backendCall.mockResolvedValue({
      data_base64: btoa('png-bytes'),
      mime_type: 'image/png',
    });

    const first = await hostFileSrc('/tmp/shot.png');
    const second = await hostFileSrc('/tmp/shot.png');
    expect(first).toBe(second);
    expect(backendCall).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    releaseHostFileSrc('/tmp/shot.png');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    releaseHostFileSrc('/tmp/shot.png');
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(first);
  });

  it('retains once per concurrent caller of the same path', async () => {
    let resolveAsset:
      | ((value: { data_base64: string; mime_type: string }) => void)
      | undefined;
    backendCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAsset = resolve;
        })
    );

    const first = hostFileSrc('/tmp/parallel.png');
    const second = hostFileSrc('/tmp/parallel.png');
    resolveAsset?.({
      data_base64: btoa('png-bytes'),
      mime_type: 'image/png',
    });

    const [firstUrl, secondUrl] = await Promise.all([first, second]);
    expect(firstUrl).toBe(secondUrl);
    expect(backendCall).toHaveBeenCalledOnce();

    releaseHostFileSrc('/tmp/parallel.png');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    releaseHostFileSrc('/tmp/parallel.png');
    expect(revokeObjectURL).toHaveBeenCalledOnce();
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
  beforeEach(() => {
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts a data URL into a typed blob URL', () => {
    const url = blobSrcFromDataUrl(
      `data:image/png;base64,${btoa('png-bytes')}`
    );
    expect(url).toBe('blob:image/png');
  });
});
