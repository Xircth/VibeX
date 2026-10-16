import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DECODED_TIMELINE_IMAGES,
  claimTimelineImage,
  releaseTimelineImage,
  resetTimelineImagesForTests,
  timelineImageHash,
  timelineImageSrc,
} from './timelineImageDecode';

describe('timeline image decode cap', () => {
  afterEach(() => {
    resetTimelineImagesForTests();
    vi.unstubAllGlobals();
  });

  it('accepts only a content-addressed hash', () => {
    expect(timelineImageHash('vibex-image:' + 'a'.repeat(64))).toBe(
      'a'.repeat(64)
    );
    expect(timelineImageHash('vibex-image:../secret')).toBeNull();
    expect(timelineImageHash('C:\\images\\shot.png')).toBeNull();
  });

  it('keeps two decoded images per panel and revokes the oldest', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: revoke });
    claimTimelineImage('panel', 'one', 'blob:one', true);
    claimTimelineImage('panel', 'two', 'blob:two', true);
    claimTimelineImage('panel', 'three', 'blob:three', true);

    expect(timelineImageSrc('panel', 'one')).toBeNull();
    expect(timelineImageSrc('panel', 'two')).toBe('blob:two');
    expect(timelineImageSrc('panel', 'three')).toBe('blob:three');
    expect(revoke).toHaveBeenCalledWith('blob:one');
    expect(MAX_DECODED_TIMELINE_IMAGES).toBe(2);

    releaseTimelineImage('panel', 'three');
    expect(revoke).toHaveBeenCalledWith('blob:three');
    expect(timelineImageSrc('panel', 'three')).toBeNull();
  });
});
