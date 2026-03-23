/**
 * Three-stage Kanban panel view state management
 *
 * Order: board(Kanban-1) -> sessionHub(Kanban-2, default) -> usageDashboard(Kanban-3)
 *
 * - board: 四栏看板视图
 * - sessionHub: 会话列表+监控视图 (默认显示页)
 * - usageDashboard: 计量统计视图
 */

export type KanbanPanelView = 'board' | 'sessionHub' | 'usageDashboard';

const PANEL_VIEWS: KanbanPanelView[] = ['board', 'sessionHub', 'usageDashboard'];

/** Default view is sessionHub (middle panel) */
export const DEFAULT_KANBAN_VIEW: KanbanPanelView = 'sessionHub';

export function getNextKanbanPanelView(current: KanbanPanelView): KanbanPanelView {
  const index = PANEL_VIEWS.indexOf(current);
  if (index < 0 || index >= PANEL_VIEWS.length - 1) {
    return current;
  }
  return PANEL_VIEWS[index + 1];
}

export function getPreviousKanbanPanelView(current: KanbanPanelView): KanbanPanelView {
  const index = PANEL_VIEWS.indexOf(current);
  if (index <= 0) {
    return current;
  }
  return PANEL_VIEWS[index - 1];
}

export function getKanbanPanelTranslateX(view: KanbanPanelView): string {
  switch (view) {
    case 'board':
      return 'translateX(0%)';
    case 'sessionHub':
      return 'translateX(-33.333%)';
    case 'usageDashboard':
      return 'translateX(-66.666%)';
    default:
      return 'translateX(-33.333%)';
  }
}

export function shouldShowLeftArrow(view: KanbanPanelView): boolean {
  return view !== 'board';
}

export function shouldShowRightArrow(view: KanbanPanelView): boolean {
  return view !== 'usageDashboard';
}
