import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCanvasWorkspaceController } from '@/components/kanban/canvas/canvasWorkspaceBridge';
import {
  CREATE_AGENT_SESSION_EVENT,
  DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT,
  REQUEST_CREATE_SESSION_OVERLAY_EVENT,
  requestCreateAgentSessionInExecutionArea,
  requestCreateSessionInExecutionArea,
  requestWorkspaceCreateSessionOverlay,
  resolveCreateSessionSurface,
} from './requestCreateSession';

const layout = vi.hoisted(() => ({
  activeTab: 'kanban' as string,
  setRightPanelVisible: vi.fn(),
  setKanbanSessionVisible: vi.fn(),
}));

vi.mock('@/stores/useLayoutStore', () => ({
  useLayoutStore: {
    getState: () => layout,
  },
}));

describe('resolveCreateSessionSurface', () => {
  it('opens create beside the session list on the infinite canvas', () => {
    expect(resolveCreateSessionSurface('canvas')).toBe('beside-session-list');
  });

  it('opens create in the execution area in fixed layout', () => {
    expect(resolveCreateSessionSurface('fixed')).toBe('execution-area');
  });
});

describe('requestCreateSessionInExecutionArea', () => {
  beforeEach(() => {
    layout.activeTab = 'kanban';
    layout.setRightPanelVisible.mockReset();
    layout.setKanbanSessionVisible.mockReset();
  });

  it('opens the active canvas create form and dismisses collaboration overlays without mutating layout', () => {
    const createSession = vi.fn();
    const openOrFocusPanel = vi.fn();
    const openOrFocusSession = vi.fn();
    const dismissCollabListener = vi.fn();
    window.addEventListener(
      DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT,
      dismissCollabListener
    );
    const unregister = registerCanvasWorkspaceController({
      createSession,
      openOrFocusPanel,
      openOrFocusSession,
      dropSessionAt: vi.fn(),
      dropPanelAt: vi.fn(),
      closeNode: vi.fn(),
      closeOtherNodes: vi.fn(),
      closeAllNodes: vi.fn(),
      duplicateNode: vi.fn(),
    });
    const setSearchParams = vi.fn();
    try {
      requestCreateSessionInExecutionArea(
        setSearchParams,
        new URLSearchParams()
      );
      expect(dismissCollabListener).toHaveBeenCalledOnce();
      expect(createSession).toHaveBeenCalledOnce();
      expect(setSearchParams).not.toHaveBeenCalled();
      expect(openOrFocusPanel).not.toHaveBeenCalled();
      expect(openOrFocusSession).not.toHaveBeenCalled();
      expect(layout.setRightPanelVisible).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT,
        dismissCollabListener
      );
      unregister();
    }
  });

  it('opens the workspace Zone B creation overlay synchronously and via URL param without mutating Dockview panel visibility', () => {
    layout.activeTab = 'workspace';
    const dismissCollabListener = vi.fn();
    const overlayListener = vi.fn();
    window.addEventListener(
      DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT,
      dismissCollabListener
    );
    window.addEventListener(
      REQUEST_CREATE_SESSION_OVERLAY_EVENT,
      overlayListener
    );
    const setSearchParams = vi.fn();
    try {
      requestCreateSessionInExecutionArea(
        setSearchParams,
        new URLSearchParams()
      );

      expect(dismissCollabListener).toHaveBeenCalledOnce();
      expect(overlayListener).toHaveBeenCalledOnce();
      expect(layout.setRightPanelVisible).not.toHaveBeenCalled();
      expect(layout.setKanbanSessionVisible).not.toHaveBeenCalled();
      const next = setSearchParams.mock.calls[0]?.[0] as URLSearchParams;
      expect(next.get('newSession')).toBe('1');
    } finally {
      window.removeEventListener(
        DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT,
        dismissCollabListener
      );
      window.removeEventListener(
        REQUEST_CREATE_SESSION_OVERLAY_EVENT,
        overlayListener
      );
    }
  });

  it('reveals the kanban execution column and asks it to create', () => {
    const setSearchParams = vi.fn();
    requestCreateSessionInExecutionArea(
      setSearchParams,
      new URLSearchParams('view=hub')
    );

    expect(layout.setRightPanelVisible).toHaveBeenCalledWith(true);
    expect(layout.setKanbanSessionVisible).toHaveBeenCalledWith(true);
    expect(setSearchParams).toHaveBeenCalledWith(expect.any(URLSearchParams), {
      replace: true,
    });
    const next = setSearchParams.mock.calls[0]?.[0] as URLSearchParams;
    expect(next.get('newSession')).toBe('1');
    expect(next.get('view')).toBe('hub');
  });

  it('dispatches CREATE_AGENT_SESSION_EVENT without mutating workspace panel widths', () => {
    layout.activeTab = 'workspace';
    const listener = vi.fn();
    window.addEventListener(CREATE_AGENT_SESSION_EVENT, listener);

    requestCreateAgentSessionInExecutionArea('CODEX');

    expect(layout.setRightPanelVisible).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0]?.[0] as CustomEvent<{
      agentId: string;
    }>;
    expect(event.detail.agentId).toBe('CODEX');

    window.removeEventListener(CREATE_AGENT_SESSION_EVENT, listener);
  });

  it('dispatches REQUEST_CREATE_SESSION_OVERLAY_EVENT with targetGroupId in Free Tabs mode', () => {
    layout.activeTab = 'workspace';
    const overlayListener = vi.fn();
    const dismissCollabListener = vi.fn();
    window.addEventListener(
      REQUEST_CREATE_SESSION_OVERLAY_EVENT,
      overlayListener
    );
    window.addEventListener(
      DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT,
      dismissCollabListener
    );

    try {
      requestWorkspaceCreateSessionOverlay('group-right-1');
      expect(dismissCollabListener).toHaveBeenCalledOnce();
      expect(overlayListener).toHaveBeenCalledOnce();
      const event = overlayListener.mock.calls[0]?.[0] as CustomEvent<{
        targetGroupId?: string | null;
      }>;
      expect(event.detail.targetGroupId).toBe('group-right-1');
      expect(layout.setRightPanelVisible).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        REQUEST_CREATE_SESSION_OVERLAY_EVENT,
        overlayListener
      );
      window.removeEventListener(
        DISMISS_COLLABORATION_CREATE_OVERLAY_EVENT,
        dismissCollabListener
      );
    }
  });
});
