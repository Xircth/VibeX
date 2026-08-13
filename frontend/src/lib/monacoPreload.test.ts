import { describe, expect, it, vi } from 'vitest';

const initializeLocalMonacoMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ editor: {} })
);

vi.mock('./monacoRuntime.local', () => ({
  initializeLocalMonaco: initializeLocalMonacoMock,
}));

import { preloadMonacoEditor } from './monacoPreload';

describe('preloadMonacoEditor', () => {
  it('deduplicates local Monaco initialization', async () => {
    const [first, second] = await Promise.all([
      preloadMonacoEditor(),
      preloadMonacoEditor(),
    ]);

    expect(first).toBe(second);
    expect(initializeLocalMonacoMock).toHaveBeenCalledTimes(1);
  });
});
