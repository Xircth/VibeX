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
}

export interface ClickToComponentOpenInEditorMessage {
  source: 'click-to-component';
  version: 1;
  type: 'open-in-editor';
  payload?: OpenInEditorPayload;
}

export interface ClickToComponentEnableMessage {
  source: 'click-to-component';
  version: 1;
  type: 'enable-button';
}

export interface ClickToComponentToolbarBridgeReadyMessage {
  source: 'click-to-component';
  version: 1;
  type: 'toolbar-bridge-ready';
}

export interface ClickToComponentSetTargetingMessage {
  source: 'click-to-component';
  version: 1;
  type: 'set-targeting';
  payload: {
    enabled: boolean;
  };
}

export type ClickToComponentMessage =
  | ClickToComponentReadyMessage
  | ClickToComponentOpenInEditorMessage
  | ClickToComponentToolbarBridgeReadyMessage;

export type ClickToComponentIframeMessage =
  | ClickToComponentEnableMessage
  | ClickToComponentSetTargetingMessage;

export interface EventHandlers {
  onReady?: () => void;
  onToolbarBridgeReady?: () => void;
  onOpenInEditor?: (payload: OpenInEditorPayload) => void;
  onUnknownMessage?: (message: unknown) => void;
}

export class ClickToComponentListener {
  private handlers: EventHandlers = {};
  private messageListener: ((event: MessageEvent) => void) | null = null;

  constructor(handlers: EventHandlers = {}) {
    this.handlers = handlers;
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

      switch (data.type) {
        case 'ready':
          this.postToMessageSource(event.source, {
            source: 'click-to-component',
            version: 1,
            type: 'enable-button',
          });
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

  enableButton(iframe: HTMLIFrameElement | null): boolean {
    return this.sendToIframe(iframe, {
      source: 'click-to-component',
      version: 1,
      type: 'enable-button',
    });
  }

  setTargetingEnabled(
    iframe: HTMLIFrameElement | null,
    enabled: boolean
  ): boolean {
    return this.sendToIframe(iframe, {
      source: 'click-to-component',
      version: 1,
      type: 'set-targeting',
      payload: { enabled },
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

  private postToMessageSource(
    target: MessageEventSource | null,
    message: ClickToComponentIframeMessage
  ): boolean {
    if (target && 'postMessage' in target) {
      (target as Window).postMessage(message, '*');
      return true;
    }

    return false;
  }
}

