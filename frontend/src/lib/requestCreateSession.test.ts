import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATE_AGENT_SESSION_EVENT,
  requestCreateAgentSessionInExecutionArea,
  requestCreateSessionInExecutionArea,
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

  it('reveals the workspace execution column without switching the kanban tab', () => {
    layout.activeTab = 'workspace';
    const setSearchParams = vi.fn();
    requestCreateSessionInExecutionArea(setSearchParams, new URLSearchParams());

    expect(layout.setRightPanelVisible).toHaveBeenCalledWith(true);
    expect(layout.setKanbanSessionVisible).not.toHaveBeenCalled();
    const next = setSearchParams.mock.calls[0]?.[0] as URLSearchParams;
    expect(next.get('newSession')).toBe('1');
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

  it('dispatches CREATE_AGENT_SESSION_EVENT and reveals the execution column', () => {
    layout.activeTab = 'workspace';
    const listener = vi.fn();
    window.addEventListener(CREATE_AGENT_SESSION_EVENT, listener);

    requestCreateAgentSessionInExecutionArea('CODEX');

    expect(layout.setRightPanelVisible).toHaveBeenCalledWith(true);
    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0]?.[0] as CustomEvent<{
      agentId: string;
    }>;
    expect(event.detail.agentId).toBe('CODEX');

    window.removeEventListener(CREATE_AGENT_SESSION_EVENT, listener);
  });
});
