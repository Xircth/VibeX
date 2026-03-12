import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { tauriInvoke, tauriListen } from '@/lib/tauri-api';
import { getTerminalTheme } from '@/utils/terminalTheme';
import type { UnlistenFn } from '@tauri-apps/api/event';

function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  platform = navigator.platform
): boolean {
  const isMac = platform.toUpperCase().includes('MAC');

  return (isMac ? event.metaKey : event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'c';
}

function shouldCopyTerminalSelection(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  hasSelection: boolean,
  platform = navigator.platform
): boolean {
  return hasSelection && isTerminalCopyShortcut(event, platform);
}

async function writeTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();

    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/**
 * Encode a string to base64 (handles binary data correctly).
 */
function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, (b) => String.fromCodePoint(b)).join('');
  return btoa(binString);
}

/**
 * Decode a base64 string to a Uint8Array for binary-safe terminal write.
 */
function decodeBase64ToBytes(base64: string): Uint8Array {
  const binString = atob(base64);
  return Uint8Array.from(binString, (c) => c.codePointAt(0)!);
}

interface UseTauriTerminalOptions {
  /** Workspace UUID to create the PTY in */
  workspaceId: string | undefined;
  /** Whether the terminal should be active (connected) */
  enabled?: boolean;
  /** Shell type override (e.g. 'powershell.exe', 'cmd.exe', 'bash') */
  shell?: string;
}

interface UseTauriTerminalResult {
  /** Ref to attach to the container div element */
  containerRef: React.RefCallback<HTMLDivElement>;
  /** Whether the terminal is connected to the PTY */
  isConnected: boolean;
  /** Error message if connection failed */
  error: string | null;
  /** Re-fit the terminal to its container (e.g. after tab becomes visible) */
  refit: () => void;
}

/**
 * Hook that manages an xterm.js Terminal instance connected to a Tauri PTY session.
 *
 * Lifecycle:
 * 1. Creates xterm.js Terminal and attaches to the container DOM element
 * 2. Installs FitAddon and WebLinksAddon
 * 3. Calls `invoke('create_terminal')` to create a PTY session
 * 4. Listens to `terminal-output:{sessionId}` for PTY output (base64-decoded)
 * 5. Forwards user input via `terminal.onData()` -> base64-encoded -> `invoke('write_terminal')`
 * 6. Forwards resize events via `terminal.onResize()` -> `invoke('resize_terminal')`
 * 7. Uses ResizeObserver to auto-fit the terminal to its container
 * 8. Cleans up everything on unmount
 */
export function useTauriTerminal({
  workspaceId,
  enabled = true,
  shell,
}: UseTauriTerminalOptions): UseTauriTerminalResult {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const isConnectedRef = useRef(false);
  const errorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  // Track whether the terminal has been opened to avoid re-opening
  const terminalOpenedRef = useRef(false);

  /**
   * Tear down the terminal and PTY connection.
   */
  const cleanup = useCallback(async () => {
    // Disconnect resize observer
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }

    // Unsubscribe from Tauri events
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    // Close PTY session on the backend
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      sessionIdRef.current = null;
      try {
        await tauriInvoke('close_terminal', { sessionId });
      } catch (err) {
        console.error('Failed to close terminal session:', err);
      }
    }

    // Dispose xterm.js terminal
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    isConnectedRef.current = false;
    terminalOpenedRef.current = false;
  }, []);

  /**
   * Initialize the terminal: create xterm instance, connect to PTY.
   */
  const initialize = useCallback(
    async (container: HTMLDivElement) => {
      if (!workspaceId || !enabled) return;

      // Clean up any previous instance
      await cleanup();

      if (!mountedRef.current) return;

      // 1. Create xterm.js Terminal instance
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'IBM Plex Mono, Menlo, Monaco, Consolas, monospace',
        theme: getTerminalTheme(),
        scrollback: 5000,
        convertEol: true,
        allowProposedApi: true,
      });
      terminalRef.current = terminal;

      // 2. Install addons
      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());

      // 3. Open terminal in container
      terminal.open(container);
      terminalOpenedRef.current = true;

      terminal.attachCustomKeyEventHandler((event) => {
        if (!shouldCopyTerminalSelection(event, terminal.hasSelection())) {
          return true;
        }

        const selection = terminal.getSelection();
        if (!selection) {
          return true;
        }

        event.preventDefault();
        event.stopPropagation();
        void writeTextToClipboard(selection);
        return false;
      });

      // Initial fit
      try {
        fitAddon.fit();
      } catch {
        // Container may not have dimensions yet
      }

      // 4. Create PTY session via Tauri
      let sessionId: string;
      try {
        sessionId = await tauriInvoke<string>('create_terminal', {
          workspaceId,
          cols: terminal.cols,
          rows: terminal.rows,
          shell: shell || null,
        });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        errorRef.current = msg;
        terminal.writeln(`\r\n\x1b[31mFailed to create terminal: ${msg}\x1b[0m`);
        return;
      }

      if (!mountedRef.current) {
        // Component unmounted during async operation
        try {
          await tauriInvoke('close_terminal', { sessionId });
        } catch {
          // ignore
        }
        terminal.dispose();
        return;
      }

      sessionIdRef.current = sessionId;

      // 5. Listen for PTY output
      try {
        const unlisten = await tauriListen<string>(
          `terminal-output:${sessionId}`,
          (payload) => {
            if (terminalRef.current && sessionIdRef.current === sessionId) {
              const bytes = decodeBase64ToBytes(payload);
              terminalRef.current.write(bytes);
            }
          }
        );
        unlistenRef.current = unlisten;
      } catch (err) {
        console.error('Failed to listen for terminal output:', err);
        errorRef.current = 'Failed to connect to terminal output';
        return;
      }

      if (!mountedRef.current) {
        cleanup();
        return;
      }

      // 6. Forward user input to PTY
      terminal.onData((data) => {
        if (sessionIdRef.current) {
          tauriInvoke('write_terminal', {
            sessionId: sessionIdRef.current,
            data: encodeBase64(data),
          }).catch((err) => {
            console.error('Failed to write to terminal:', err);
          });
        }
      });

      // 7. Forward resize events to PTY
      terminal.onResize(({ cols, rows }) => {
        if (sessionIdRef.current) {
          tauriInvoke('resize_terminal', {
            sessionId: sessionIdRef.current,
            cols,
            rows,
          }).catch((err) => {
            console.error('Failed to resize terminal:', err);
          });
        }
      });

      // 8. Setup ResizeObserver for auto-fit
      const ro = new ResizeObserver(() => {
        if (fitAddonRef.current && terminalRef.current) {
          try {
            fitAddonRef.current.fit();
          } catch {
            // Ignore fit errors (e.g. when container has zero dimensions)
          }
        }
      });
      ro.observe(container);
      resizeObserverRef.current = ro;

      isConnectedRef.current = true;
      errorRef.current = null;
    },
    [workspaceId, enabled, shell, cleanup]
  );

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  /**
   * Ref callback for the container div.
   * When the div mounts, initialize the terminal.
   * When it unmounts (null), clean up.
   */
  const containerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && el !== containerElRef.current) {
        containerElRef.current = el;
        initialize(el);
      } else if (!el && containerElRef.current) {
        containerElRef.current = null;
        cleanup();
      }
    },
    [initialize, cleanup]
  );

  const refit = useCallback(() => {
    if (fitAddonRef.current && terminalOpenedRef.current) {
      try {
        fitAddonRef.current.fit();
      } catch {
        /* container may have zero size */
      }
    }
  }, []);

  return {
    containerRef,
    isConnected: isConnectedRef.current,
    error: errorRef.current,
    refit,
  };
}
