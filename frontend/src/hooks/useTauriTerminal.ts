import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { tauriInvoke, tauriListen } from '@/lib/tauriApi';
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
  /** Shell type override (e.g. 'powershell.exe', 'cmd.exe') */
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
  /** Error message if connection failed */
  error: string | null;
  /** Re-fit the terminal to its container (e.g. after tab becomes visible) */
  refit: () => void;
}

const MIN_TERMINAL_CONTAINER_SIZE = 16;

function hasUsableTerminalContainer(element: HTMLElement): boolean {
  if (!element.isConnected) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return (
    rect.width >= MIN_TERMINAL_CONTAINER_SIZE &&
    rect.height >= MIN_TERMINAL_CONTAINER_SIZE
  );
}

function hasLiveTerminalElement(
  terminal: Terminal,
  container: HTMLElement
): boolean {
  const element = terminal.element;
  return !!element && element.isConnected && container.contains(element);
}

function fitTerminalIfReady(
  fitAddon: FitAddon,
  terminal: Terminal,
  container: HTMLElement
): void {
  if (
    !hasUsableTerminalContainer(container) ||
    !hasLiveTerminalElement(terminal, container)
  ) {
    return;
  }

  try {
    fitAddon.fit();
  } catch {
    // The Dockview panel may be mid-layout or hidden.
  }
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
  const themeUnlistenRef = useRef<UnlistenFn | null>(null);
  const themeObserverRef = useRef<MutationObserver | null>(null);
  const containerElRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const onSessionIdRef = useRef(onSessionId);
  const onLinkActivatedRef = useRef(onLinkActivated);
  const errorRef = useRef<string | null>(null);
  const [errorState, setErrorState] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const terminalOpenedRef = useRef(false);
  const initializeVersionRef = useRef(0);
  const pendingInitObserverRef = useRef<ResizeObserver | null>(null);
  const pendingInitFrameRef = useRef<number | null>(null);

  useEffect(() => {
    onSessionIdRef.current = onSessionId;
  }, [onSessionId]);

  useEffect(() => {
    onLinkActivatedRef.current = onLinkActivated;
  }, [onLinkActivated]);

  useEffect(() => {
    sessionIdRef.current = sessionId ?? null;
  }, [sessionId]);

  const disposeView = useCallback(() => {
    initializeVersionRef.current += 1;

    if (pendingInitObserverRef.current) {
      pendingInitObserverRef.current.disconnect();
      pendingInitObserverRef.current = null;
    }
    if (pendingInitFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingInitFrameRef.current);
      pendingInitFrameRef.current = null;
    }

    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }

    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    if (themeUnlistenRef.current) {
      themeUnlistenRef.current();
      themeUnlistenRef.current = null;
    }

    if (themeObserverRef.current) {
      themeObserverRef.current.disconnect();
      themeObserverRef.current = null;
    }

    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    errorRef.current = null;
    terminalOpenedRef.current = false;
  }, []);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposeView();
    };
  }, [disposeView]);

  const initialize = useCallback(
    async (container: HTMLDivElement) => {
      if (!workspaceId || !enabled) return;

      disposeView();

      if (!mountedRef.current) return;
      errorRef.current = null;
      setErrorState((current) => (current === null ? current : null));

      const initializeVersion = initializeVersionRef.current + 1;
      initializeVersionRef.current = initializeVersion;

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

      const isCurrentInitialization = () =>
        mountedRef.current &&
        initializeVersionRef.current === initializeVersion &&
        terminalRef.current === terminal &&
        containerElRef.current === container &&
        terminalOpenedRef.current &&
        hasLiveTerminalElement(terminal, container);

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(
        new WebLinksAddon((event, uri) => {
          event.preventDefault();
          onLinkActivatedRef.current?.(uri);
        })
      );

      terminal.open(container);
      terminalOpenedRef.current = true;

      const applyCurrentTheme = () => {
        const term = terminalRef.current;
        const activeContainer = containerElRef.current;
        if (!term || !activeContainer) {
          return;
        }

        // Assigning `options.theme` synchronously drives xterm's
        // onDimensionsChange -> Viewport.syncScrollArea, and refresh() schedules
        // the same on a RAF. Both read RenderService.dimensions, which throws
        // ("Cannot read properties of undefined (reading 'dimensions')") when the
        // terminal sits in the hidden/zero-size Dockview panel (renderer never
        // sized) or is mid-dispose. Only touch it once it is open and on-screen.
        if (
          !terminalOpenedRef.current ||
          !hasUsableTerminalContainer(activeContainer) ||
          !hasLiveTerminalElement(term, activeContainer)
        ) {
          return;
        }

        try {
          term.options.theme = getTerminalTheme();
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch {
          // Panel may be mid-layout, hidden, or disposing.
        }
      };

      applyCurrentTheme();

      tauriListen<{ theme: string }>('theme-changed', () => {
        applyCurrentTheme();
      }).then((unlisten) => {
        if (!mountedRef.current || !terminalRef.current) {
          unlisten();
          return;
        }
        themeUnlistenRef.current = unlisten;
      });

      const themeObserver = new MutationObserver(() => {
        applyCurrentTheme();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
      const legacyScope = document.querySelector('.legacy-design');
      if (legacyScope) {
        themeObserver.observe(legacyScope, {
          attributes: true,
          attributeFilter: ['class', 'style'],
        });
      }
      themeObserverRef.current = themeObserver;

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

      fitTerminalIfReady(fitAddon, terminal, container);

      const attachListener = async (currentSessionId: string) => {
        const unlisten = await tauriListen<string>(
          `terminal-output:${currentSessionId}`,
          (payload) => {
            if (
              isCurrentInitialization() &&
              sessionIdRef.current === currentSessionId
            ) {
              const bytes = decodeBase64ToBytes(payload);
              try {
                terminal.write(bytes);
              } catch (error) {
                console.warn('Failed to write terminal output:', error);
              }
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
            setErrorState(message);
            if (isCurrentInitialization()) {
              terminal.writeln(
                `\r\n\x1b[31mFailed to create terminal for ${tabId}: ${message}\x1b[0m`
              );
            }
            return;
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          errorRef.current = message;
          setErrorState(message);
          if (isCurrentInitialization()) {
            terminal.writeln(
              `\r\n\x1b[31mFailed to attach terminal for ${tabId}: ${message}\x1b[0m`
            );
          }
          return;
        }
      }

      if (!isCurrentInitialization() || !resolvedSessionId) {
        if (terminalRef.current === terminal) {
          disposeView();
        } else {
          terminal.dispose();
        }
        return;
      }

      sessionIdRef.current = resolvedSessionId;
      onSessionIdRef.current?.(resolvedSessionId);

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
        if (isCurrentInitialization() && sessionIdRef.current) {
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
        if (fitAddonRef.current && isCurrentInitialization()) {
          fitTerminalIfReady(fitAddonRef.current, terminal, container);
        }
      });
      resizeObserver.observe(container);
      resizeObserverRef.current = resizeObserver;
      errorRef.current = null;
    },
    [
      workspaceId,
      enabled,
      shell,
      tabId,
      readOnly,
      disposeView,
    ]
  );

  const initializeWhenReady = useCallback(
    (container: HTMLDivElement) => {
      if (!workspaceId || !enabled || !mountedRef.current) {
        return;
      }

      if (hasUsableTerminalContainer(container)) {
        void initialize(container);
        return;
      }

      if (pendingInitObserverRef.current) {
        pendingInitObserverRef.current.disconnect();
        pendingInitObserverRef.current = null;
      }
      if (pendingInitFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingInitFrameRef.current);
        pendingInitFrameRef.current = null;
      }

      const tryInitialize = () => {
        pendingInitFrameRef.current = null;
        if (
          !mountedRef.current ||
          !workspaceId ||
          !enabled ||
          containerElRef.current !== container
        ) {
          pendingInitObserverRef.current?.disconnect();
          pendingInitObserverRef.current = null;
          return;
        }

        if (hasUsableTerminalContainer(container)) {
          pendingInitObserverRef.current?.disconnect();
          pendingInitObserverRef.current = null;
          void initialize(container);
          return;
        }

        pendingInitFrameRef.current =
          window.requestAnimationFrame(tryInitialize);
      };

      pendingInitObserverRef.current = new ResizeObserver(tryInitialize);
      pendingInitObserverRef.current.observe(container);
      pendingInitFrameRef.current = window.requestAnimationFrame(tryInitialize);
    },
    [enabled, initialize, workspaceId]
  );

  useLayoutEffect(() => {
    const container = containerElRef.current;
    if (!container || !workspaceId || !enabled) {
      return;
    }

    initializeWhenReady(container);
  }, [workspaceId, enabled, shell, readOnly, initializeWhenReady]);

  const containerRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (element && element !== containerElRef.current) {
        containerElRef.current = element;
        initializeWhenReady(element);
      } else if (!element && containerElRef.current) {
        containerElRef.current = null;
        disposeView();
      }
    },
    [disposeView, initializeWhenReady]
  );

  const refit = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerElRef.current;
    if (terminal && fitAddon && container && terminalOpenedRef.current) {
      fitTerminalIfReady(fitAddon, terminal, container);
    }
  }, []);

  return {
    containerRef,
    error: errorState,
    refit,
  };
}
