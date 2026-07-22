export type BrowserTabId = string;

export type BrowserProfile =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'ephemeral' };

export interface BrowserSurface {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  visible: boolean;
}

export interface CreateBrowserTab {
  initialUrl: string;
  profile: BrowserProfile;
  surface: BrowserSurface;
}

export interface BrowserTab {
  id: BrowserTabId;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomLevel: number;
  profile: BrowserProfile;
  surface: BrowserSurface;
}

export type BrowserIntent =
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'stop' }
  | { type: 'setSurface'; surface: BrowserSurface }
  | { type: 'focus' }
  | { type: 'openDevTools' }
  | { type: 'setZoom'; level: number }
  | {
      type: 'find';
      query: string;
      forward: boolean;
      matchCase: boolean;
      findNext: boolean;
    }
  | { type: 'stopFinding' }
  | { type: 'resolvePermission'; requestId: number; allow: boolean }
  | { type: 'cancelDownload'; downloadId: number }
  | {
      type: 'executeDevTools';
      requestId: number;
      method: string;
      params: unknown;
    };

export type BrowserEvent =
  | { type: 'tabCreated'; tab: BrowserTab }
  | { type: 'tabUpdated'; tab: BrowserTab }
  | { type: 'tabClosed'; tabId: BrowserTabId }
  | {
      type: 'popupCreated';
      openerTabId: BrowserTabId;
      tab: BrowserTab;
    }
  | {
      type: 'permissionRequested';
      tabId: BrowserTabId;
      requestId: number;
      origin: string;
      kind: 'media' | 'generic';
      requestedPermissions: number;
    }
  | {
      type: 'downloadUpdated';
      tabId: BrowserTabId;
      downloadId: number;
      url: string;
      fileName: string;
      receivedBytes: number;
      totalBytes: number;
      percentComplete: number;
      state: 'inProgress' | 'complete' | 'canceled' | 'interrupted';
    }
  | {
      type: 'tabFailed';
      tab: BrowserTab;
      code: string;
      message: string;
    }
  | {
      type: 'devToolsResult';
      tabId: BrowserTabId;
      requestId: number;
      success: boolean;
      result: unknown;
    }
  | {
      type: 'devToolsEvent';
      tabId: BrowserTabId;
      method: string;
      params: unknown;
    };

export interface BrowserCommandError {
  code: string;
  message: string;
}
