import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadyContent } from './ReadyContent';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

function NavigablePreview() {
  const [url, setUrl] = useState('http://localhost:5173');

  return (
    <ReadyContent
      url={url}
      displayUrl={url}
      iframeKey={url}
      onIframeError={() => undefined}
      onUrlChange={setUrl}
    />
  );
}

describe('ReadyContent', () => {
  it('does not embed a remote HTTPS page in an iframe rejected by framing policy', () => {
    const { container } = render(<NavigablePreview />);
    const addressInput = screen.getByRole('textbox');

    fireEvent.change(addressInput, {
      target: { value: 'https://www.baidu.com' },
    });
    fireEvent.keyDown(addressInput, { key: 'Enter' });

    expect(
      container.querySelector('iframe[src="https://www.baidu.com"]')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('native-webview-preview')).toBeInTheDocument();
  });

  it('keeps loopback development servers in the instrumented iframe', () => {
    const { container } = render(
      <ReadyContent
        url="http://5173.localhost:43123"
        displayUrl="http://localhost:5173"
        iframeKey="local-preview"
        onIframeError={() => undefined}
      />
    );

    expect(
      container.querySelector('iframe[src="http://5173.localhost:43123"]')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('native-webview-preview')
    ).not.toBeInTheDocument();
  });

  it('keeps a native preview creation failure visible instead of silently resetting the panel', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('permission denied'));
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
    const onIframeError = vi.fn();

    render(
      <ReadyContent
        url="https://www.baidu.com"
        displayUrl="https://www.baidu.com"
        iframeKey="external-preview"
        onIframeError={onIframeError}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'permission denied'
    );
    await waitFor(() => expect(onIframeError).not.toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox')).toHaveValue('https://www.baidu.com');
  });
});
