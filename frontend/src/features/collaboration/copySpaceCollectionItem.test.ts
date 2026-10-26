import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copySpaceCollectionItem } from './copySpaceCollectionItem';
import type { SpaceCollectionItemRecord } from './CollaborationSpaceCollectionPanel';

const { hostFileSrc } = vi.hoisted(() => ({
  hostFileSrc: vi.fn(async () => 'blob:collection-image'),
}));

vi.mock('@/lib/hostAsset', () => ({
  hostFileSrc,
  releaseHostFileSrc: vi.fn(),
}));

function collectionItem(
  overrides: Partial<SpaceCollectionItemRecord>
): SpaceCollectionItemRecord {
  return {
    id: 'col-1',
    space_id: 's1',
    project_id: 'p1',
    creator_nickname: 'User',
    file_path: '/tmp/saved.md',
    byte_size: 12,
    note: '',
    created_at: '2026-10-23T01:00:00Z',
    ...overrides,
  };
}

describe('copySpaceCollectionItem', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const write = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    write.mockClear();
    hostFileSrc.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, write },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copies text collection content to the clipboard', async () => {
    await copySpaceCollectionItem(
      collectionItem({
        item_kind: 'text',
        text_content: 'GET /api/v1/spaces',
      })
    );

    expect(writeText).toHaveBeenCalledWith('GET /api/v1/spaces');
    expect(write).not.toHaveBeenCalled();
  });

  it('copies image collection bytes onto the clipboard', async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], {
      type: 'image/png',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () => blob,
      }))
    );
    vi.stubGlobal(
      'ClipboardItem',
      class ClipboardItem {
        constructor(public items: Record<string, Blob>) {}
      }
    );

    await copySpaceCollectionItem(
      collectionItem({
        id: 'col-img',
        item_kind: 'image',
        file_path: '/tmp/shot.png',
        file_name: 'shot.png',
      })
    );

    expect(hostFileSrc).toHaveBeenCalledWith('/tmp/shot.png');
    expect(write).toHaveBeenCalledTimes(1);
    const payload = write.mock.calls[0]?.[0]?.[0] as {
      items: Record<string, Blob>;
    };
    expect(payload.items['image/png']).toBe(blob);
  });
});
