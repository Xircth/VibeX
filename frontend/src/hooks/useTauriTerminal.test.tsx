import { act, render } from '@testing-library/react';
import { useTauriTerminal } from './useTauriTerminal';

const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(),
}));

vi.mock('@/lib/backendTransport', () => ({
  backendCall: vi.fn(),
  backendListen: vi.fn(),
}));

function TerminalHarness() {
  const { containerRef } = useTauriTerminal({
    workspaceId: 'workspace-1',
    tabId: 'terminal-1',
  });

  return <div ref={containerRef} data-testid="terminal-container" />;
}

describe('useTauriTerminal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: originalGetBoundingClientRect,
    });
  });

  it('does not poll every animation frame while a newly shown panel has no size', () => {
    let nextFrameId = 0;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrameId += 1;
      pendingFrames.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelFrame = vi.fn((frameId: number) => {
      pendingFrames.delete(frameId);
    });

    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    render(<TerminalHarness />);

    expect(pendingFrames).toHaveLength(1);
    const pendingFrame = Array.from(pendingFrames.entries())[0];
    pendingFrames.delete(pendingFrame[0]);

    act(() => pendingFrame[1](0));

    expect(pendingFrames).toHaveLength(0);
  });
});
