import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { NativeWebviewPreview } from './NativeWebviewPreview';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('NativeWebviewPreview', () => {
  it('creates a Tauri child WebView for an external URL', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke,
        metadata: {
          currentWindow: { label: 'main' },
        },
      },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 80,
      top: 80,
      right: 820,
      bottom: 680,
      left: 20,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });

    const onCreated = vi.fn();
    const { unmount } = render(
      <NativeWebviewPreview url="https://www.baidu.com" onCreated={onCreated} />
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'plugin:webview|create_webview',
        expect.objectContaining({
          windowLabel: 'main',
          options: expect.objectContaining({
            url: 'https://www.baidu.com',
            x: 20,
            y: 80,
            width: 800,
            height: 600,
          }),
        }),
        undefined
      );
      expect(onCreated).toHaveBeenCalledOnce();
    });

    unmount();
  });
});
