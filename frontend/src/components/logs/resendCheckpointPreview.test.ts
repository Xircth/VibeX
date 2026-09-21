import { describe, expect, it, vi } from 'vitest';
import { loadResendCheckpointPreview } from './resendCheckpointPreview';

describe('loadResendCheckpointPreview', () => {
  it('returns checkpoint files when the preview resolves in time', async () => {
    await expect(
      loadResendCheckpointPreview(
        async () => ({
          files: [{ path: 'src/a.ts' } as never],
        }),
        50
      )
    ).resolves.toEqual({
      files: [{ path: 'src/a.ts' }],
      previewUnavailable: false,
    });
  });

  it('does not block resend when git preview hangs', async () => {
    vi.useFakeTimers();
    const preview = loadResendCheckpointPreview(() => new Promise(() => {}), 40);
    const timeout = vi.advanceTimersByTimeAsync(40);
    await timeout;
    await expect(preview).resolves.toEqual({
      files: [],
      previewUnavailable: true,
    });
    vi.useRealTimers();
  });
});
