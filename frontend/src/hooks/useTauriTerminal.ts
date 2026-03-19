import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { tauriInvoke, tauriListen } from '@/lib/tauri-api';
import { getTerminalTheme } from '@/utils/terminalTheme';
import type { UnlistenFn } from '@tauri-apps/api/event';

function isTerminalCopyShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
  >,
  platform = navigator.platform
): boolean {
  const isMac = platform.toUpperCase().includes('MAC');

  return (
    (isMac ? event.metaKey : event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'c'
  );
}

function shouldCopyTerminalSelection(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
  >,
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

function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, (byte) =>
    String.fromCodePoint(byte)
  ).join('');
  return btoa(binString);
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binString = atob(base64);
  return Uint8Array.from(binString, (char) => char.codePointAt(0)!);
}

interface UseTauriTerminalOptions {
  /** Workspace UUID to create the PTY in */
  workspaceId: string | undefined;
  /** Frontend terminal tab id */
  tabId: string;
  /** Existing PTY session id to reattach */
  sessionId?: string | null;
  /** Whether the terminal should be active (connected) */
  enabled?: boolean;
  /** Shell type override (e.g. 'powershell.exe', 'cmd.exe', 'bash') */
  shell?: string;
  /** Called whenever a PTY session id is attached or created */
  onSessionId?: (sessionId: string) => void;
  /** Called when a terminal link is activated */
  onLinkActivated?: (url: string) => void;
  /** Prevent user input from being written into the terminal */
  readOnly?: boolean;
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

export function useTauriTerminal({
  workspaceId,
  tabId,
  sessionId,
  enabled = true,
  shell,
  onSessionId,
  onLinkActivated,
  readOnly = false,
}: UseTauriTerminalOptions): UseTauriTerminalResult {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const isConnectedRef = useRef(false);
  const errorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const terminalOpenedRef = useRef(false);

  useEffect(() => {
    sessionIdRef.current = sessionId ?? null;
  }, [sessionId]);

  const disposeView = useCallback(() => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }

    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    isConnectedRef.current = false;
    terminalOpenedRef.current = false;
  }, []);

  const initialize = useCallback(
    async (container: HTMLDivElement) => {
      if (!workspaceId || !enabled) return;

      disposeView();

      if (!mountedRef.current) return;

      const terminal = new Terminal({
        cursorBlink: !readOnly,
        fontSize: 13,
        fontFamily: 'IBM Plex Mono, Menlo, Monaco, Consolas, monospace',
        theme: getTerminalTheme(),
        scrollback: 5000,
        convertEol: true,
        allowProposedApi: true,
        disableStdin: readOnly,
      });
      terminalRef.current = terminal;

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(
        new WebLinksAddon((event, uri) => {
          event.preventDefault();
          onLinkActivated?.(uri);
        })
      );

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

      try {
        fitAddon.fit();
      } catch {
        // Container may not have dimensions yet
      }

      const attachListener = async (currentSessionId: string) => {
        const unlisten = await tauriListen<string>(
          `terminal-output:${currentSessionId}`,
          (payload) => {
            if (
              terminalRef.current &&
              sessionIdRef.current === currentSessionId
            ) {
              const bytes = decodeBase64ToBytes(payload);
              terminalRef.current.write(bytes);
            }
          }
        );
        unlistenRef.current = unlisten;
      };

      let resolvedSessionId = sessionIdRef.current;

      try {
        if (resolvedSessionId) {
          await attachListener(resolvedSessionId);
          await tauriInvoke<string>('attach_terminal', {
            sessionId: resolvedSessionId,
          });
        } else {
          resolvedSessionId = crypto.randomUUID();
          await attachListener(resolvedSessionId);
          await tauriInvoke<string>('create_terminal', {
            workspaceId,
            cols: terminal.cols,
            rows: terminal.rows,
            shell: shell || null,
            sessionId: resolvedSessionId,
          });
        }
      } catch (err) {
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }

        if (resolvedSessionId && resolvedSessionId === sessionIdRef.current) {
          try {
            resolvedSessionId = crypto.randomUUID();
            await attachListener(resolvedSessionId);
            await tauriInvoke<string>('create_terminal', {
              workspaceId,
              cols: terminal.cols,
              rows: terminal.rows,
              shell: shell || null,
              sessionId: resolvedSessionId,
            });
          } catch (fallbackErr) {
            const message =
              fallbackErr instanceof Error
                ? fallbackErr.message
                : String(fallbackErr);
            errorRef.current = message;
            terminal.writeln(
              `\r\n\x1b[31mFailed to create terminal for ${tabId}: ${message}\x1b[0m`
            );
            return;
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          errorRef.current = message;
          terminal.writeln(
            `\r\n\x1b[31mFailed to attach terminal for ${tabId}: ${message}\x1b[0m`
          );
          return;
        }
      }

      if (!mountedRef.current || !resolvedSessionId) {
        disposeView();
        return;
      }

      sessionIdRef.current = resolvedSessionId;
      onSessionId?.(resolvedSessionId);

      if (!readOnly) {
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
      }

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

      const resizeObserver = new ResizeObserver(() => {
        if (fitAddonRef.current && terminalRef.current) {
          try {
            fitAddonRef.current.fit();
          } catch {
            // Ignore fit errors when container is hidden
          }
        }
      });
      resizeObserver.observe(container);
      resizeObserverRef.current = resizeObserver;

      isConnectedRef.current = true;
      errorRef.current = null;
    },
    [
      workspaceId,
      enabled,
      shell,
      tabId,
      onSessionId,
      onLinkActivated,
      readOnly,
      disposeView,
    ]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposeView();
    };
  }, [disposeView]);

  const containerRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (element && element !== containerElRef.current) {
        containerElRef.current = element;
        void initialize(element);
      } else if (!element && containerElRef.current) {
        containerElRef.current = null;
        disposeView();
      }
    },
    [initialize, disposeView]
  );

  const refit = useCallback(() => {
    if (fitAddonRef.current && terminalOpenedRef.current) {
      try {
        fitAddonRef.current.fit();
      } catch {
        // Container may currently have zero size
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
