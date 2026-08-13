import { act, render, waitFor } from '@testing-library/react';
import { useTauriTerminal } from './useTauriTerminal';

const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;

const { backendCall, backendListen, terminalInstances } = vi.hoisted(() => ({
  backendCall: vi.fn(),
  backendListen: vi.fn(),
  terminalInstances: [] as Array<{
    emitData: (data: string) => void;
  }>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function MockTerminal() {
    const dataListeners = new Set<(data: string) => void>();
    const instance = {
      cols: 80,
      rows: 24,
      element: undefined as HTMLDivElement | undefined,
      options: {
        fontFamily: 'monospace',
        theme: {},
      },
      loadAddon: vi.fn(),
      open: vi.fn((container: HTMLElement) => {
        instance.element = document.createElement('div');
        container.appendChild(instance.element);
      }),
      dispose: vi.fn(() => instance.element?.remove()),
      refresh: vi.fn(),
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ''),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      }),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      writeln: vi.fn(),
      emitData: (data: string) => {
        dataListeners.forEach((listener) => listener(data));
      },
    };
    terminalInstances.push(instance);
    return instance;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function MockFitAddon() {
    return { fit: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(function MockWebLinksAddon() {}),
}));

vi.mock('@/lib/backendTransport', () => ({
  backendCall,
  backendListen,
}));

function TerminalHarness({ sessionId }: { sessionId?: string }) {
  const { containerRef, error } = useTauriTerminal({
    workspaceId: 'workspace-1',
    tabId: 'terminal-1',
    sessionId,
  });

  return (
    <div ref={containerRef} data-testid="terminal-container">
      {error}
    </div>
  );
}

describe('useTauriTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalInstances.length = 0;
    backendListen.mockResolvedValue(() => {});
  });

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

  it('preserves rapid input typed while the PTY session is still opening', async () => {
    const finishCreatingTerminals: Array<(sessionId: string) => void> = [];
    backendCall.mockImplementation((command: string) => {
      if (command === 'create_terminal') {
        return new Promise<string>((resolve) => {
          finishCreatingTerminals.push(resolve);
        });
      }
      return Promise.resolve(undefined);
    });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );

    render(<TerminalHarness />);

    await waitFor(() =>
      expect(backendCall).toHaveBeenCalledWith(
        'create_terminal',
        expect.objectContaining({ workspaceId: 'workspace-1' })
      )
    );
    expect(
      backendCall.mock.calls.filter(
        ([command]) => command === 'create_terminal'
      )
    ).toHaveLength(1);

    const activeTerminal = terminalInstances.at(-1)!;
    activeTerminal.emitData('c');
    activeTerminal.emitData('d');
    activeTerminal.emitData(' ');
    activeTerminal.emitData('.');
    activeTerminal.emitData('.');

    await act(async () => {
      finishCreatingTerminals.forEach((finish) => finish('session-1'));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(backendCall).toHaveBeenCalledWith('write_terminal', {
        sessionId: expect.any(String),
        data: btoa('cd ..'),
      })
    );
  });

  it('exposes a failed reattach without replacing the PTY session', async () => {
    backendCall.mockImplementation((command: string) => {
      if (command === 'attach_terminal') {
        return Promise.reject(new Error('PTY session no longer exists'));
      }
      return Promise.resolve(undefined);
    });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );

    const view = render(<TerminalHarness sessionId="existing-session" />);

    await waitFor(() =>
      expect(view.getByText('PTY session no longer exists')).toBeTruthy()
    );
    expect(backendCall).toHaveBeenCalledWith('attach_terminal', {
      sessionId: 'existing-session',
    });
    expect(
      backendCall.mock.calls.filter(
        ([command]) => command === 'create_terminal'
      )
    ).toHaveLength(0);
  });

  it('serializes rapid input while an earlier PTY write is still pending', async () => {
    let finishFirstWrite: (() => void) | undefined;
    let writeCount = 0;
    backendCall.mockImplementation((command: string) => {
      if (command === 'write_terminal') {
        writeCount += 1;
        if (writeCount === 1) {
          return new Promise<void>((resolve) => {
            finishFirstWrite = resolve;
          });
        }
      }
      return Promise.resolve(undefined);
    });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );

    render(<TerminalHarness />);

    await waitFor(() =>
      expect(backendCall).toHaveBeenCalledWith(
        'create_terminal',
        expect.objectContaining({ workspaceId: 'workspace-1' })
      )
    );

    const activeTerminal = terminalInstances.at(-1)!;
    activeTerminal.emitData('c');
    await waitFor(() =>
      expect(
        backendCall.mock.calls.filter(
          ([command]) => command === 'write_terminal'
        )
      ).toHaveLength(1)
    );

    for (const character of ['d', ' ', '.', '.']) {
      activeTerminal.emitData(character);
      await act(async () => Promise.resolve());
    }

    expect(
      backendCall.mock.calls.filter(([command]) => command === 'write_terminal')
    ).toHaveLength(1);

    await act(async () => {
      finishFirstWrite?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        backendCall.mock.calls.filter(
          ([command]) => command === 'write_terminal'
        )
      ).toHaveLength(2)
    );

    const writtenText = backendCall.mock.calls
      .filter(([command]) => command === 'write_terminal')
      .map(([, args]) => atob((args as { data: string }).data))
      .join('');
    expect(writtenText).toBe('cd ..');
  });
});
