export interface ComponentSource {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

export interface ComponentInfo {
  name: string;
  props: Record<string, unknown>;
  source: ComponentSource;
  pathToSource: string;
}

export interface SelectedComponent extends ComponentInfo {
  editor: string;
  url: string;
}

export interface ClickedElement {
  tag?: string;
  id?: string;
  className?: string;
  role?: string;
  dataset?: Record<string, string>;
}

export interface Coordinates {
  x?: number;
  y?: number;
}

export interface OpenInEditorPayload {
  selected: SelectedComponent;
  components: ComponentInfo[];
  trigger: 'alt-click' | 'context-menu';
  coords?: Coordinates;
  clickedElement?: ClickedElement;
}

export interface ClickToComponentReadyMessage {
  source: 'click-to-component';
  version: 1;
  type: 'ready';
  bridgeToken?: string;
}

export interface ClickToComponentOpenInEditorMessage {
  source: 'click-to-component';
  version: 1;
  type: 'open-in-editor';
  payload?: OpenInEditorPayload;
  bridgeToken?: string;
}

export interface ClickToComponentDetectedMessage {
  source: 'click-to-component';
  version: 2;
  type: 'component-detected';
  payload?: unknown;
  bridgeToken?: string;
}

export interface ClickToComponentEnableMessage {
  source: 'click-to-component';
  version: 1;
  type: 'enable-button';
  bridgeToken?: string;
}

export interface ClickToComponentToolbarBridgeReadyMessage {
  source: 'click-to-component';
  version: 1;
  type: 'toolbar-bridge-ready';
  bridgeToken?: string;
}

export interface ClickToComponentSetTargetingMessage {
  source: 'click-to-component';
  version: 1;
  type: 'set-targeting';
  payload: {
    enabled: boolean;
  };
  bridgeToken?: string;
}

export interface PreviewConsolePayload {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
  line?: number | null;
  column?: number | null;
  timestamp: number;
}

export interface PreviewConsoleMessage {
  source: 'click-to-component';
  version: 1;
  type: 'console';
  payload: PreviewConsolePayload;
  bridgeToken?: string;
}

export interface PreviewNetworkPayload {
  kind: 'fetch' | 'xhr';
  method: string;
  url: string;
  status: number | null;
  ok: boolean | null;
  durationMs: number | null;
  error: string | null;
  timestamp: number;
}

export interface PreviewNetworkMessage {
  source: 'click-to-component';
  version: 1;
  type: 'network';
  payload: PreviewNetworkPayload;
  bridgeToken?: string;
}

export type ClickToComponentMessage =
  | ClickToComponentReadyMessage
  | ClickToComponentOpenInEditorMessage
  | ClickToComponentDetectedMessage
  | ClickToComponentToolbarBridgeReadyMessage
  | PreviewConsoleMessage
  | PreviewNetworkMessage;

export type ClickToComponentIframeMessage =
  | ClickToComponentEnableMessage
  | ClickToComponentSetTargetingMessage;

export interface EventHandlers {
  onReady?: () => void;
  onToolbarBridgeReady?: () => void;
  onOpenInEditor?: (payload: OpenInEditorPayload) => void;
  onConsole?: (payload: PreviewConsolePayload) => void;
  onNetwork?: (payload: PreviewNetworkPayload) => void;
  onUnknownMessage?: (message: unknown) => void;
}

export class ClickToComponentListener {
  private handlers: EventHandlers = {};
  private messageListener: ((event: MessageEvent) => void) | null = null;
  private getBridgeToken: (() => string | null) | null = null;

  constructor(
    handlers: EventHandlers = {},
    getBridgeToken?: () => string | null
  ) {
    this.handlers = handlers;
    this.getBridgeToken = getBridgeToken ?? null;
  }

  /**
   * Start listening for messages from click-to-component iframe
   */
  start(): void {
    if (this.messageListener) {
      this.stop(); // Clean up existing listener
    }

    this.messageListener = (event: MessageEvent) => {
      const data = event.data as ClickToComponentMessage;

      // Only handle messages from our click-to-component tool
      if (!data || data.source !== 'click-to-component') {
        return;
      }

      const currentBridgeToken = this.getBridgeToken?.() ?? null;
      if (data.type !== 'ready') {
        if (!currentBridgeToken || data.bridgeToken !== currentBridgeToken) {
          return;
        }
      }

      switch (data.type) {
        case 'ready':
          this.handlers.onReady?.();
          break;

        case 'open-in-editor':
          if (data.payload) {
            this.handlers.onOpenInEditor?.(data.payload);
          }
          break;

        case 'toolbar-bridge-ready':
          this.handlers.onToolbarBridgeReady?.();
          break;

        case 'console':
          if (data.payload) {
            this.handlers.onConsole?.(data.payload);
          }
          break;

        case 'network':
          if (data.payload) {
            this.handlers.onNetwork?.(data.payload);
          }
          break;

        default:
          this.handlers.onUnknownMessage?.(data);
      }
    };

    window.addEventListener('message', this.messageListener);
  }

  /**
   * Stop listening for messages
   */
  stop(): void {
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
  }

  /**
   * Update event handlers
   */
  setHandlers(handlers: EventHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  enableButton(
    iframe: HTMLIFrameElement | null,
    bridgeToken?: string
  ): boolean {
    return this.sendToIframe(iframe, {
      source: 'click-to-component',
      version: 1,
      type: 'enable-button',
      bridgeToken,
    });
  }

  setTargetingEnabled(
    iframe: HTMLIFrameElement | null,
    enabled: boolean,
    bridgeToken?: string
  ): boolean {
    return this.sendToIframe(iframe, {
      source: 'click-to-component',
      version: 1,
      type: 'set-targeting',
      payload: { enabled },
      bridgeToken,
    });
  }

  sendToIframe(
    iframe: HTMLIFrameElement | null,
    message: ClickToComponentIframeMessage
  ): boolean {
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(message, '*');
      return true;
    }

    return false;
  }
}
