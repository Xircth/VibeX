import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
});
