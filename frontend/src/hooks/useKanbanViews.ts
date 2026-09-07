import { useMemo } from 'react';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import { useKanbanBoardStyle } from '@/lib/kanbanBoardStyle';
import { kanbanViewsFromCatalog } from '@/lib/kanbanViewCatalog';
import {
  kanbanViewsForBoardStyle,
  type KanbanViewDescriptor,
} from '@/lib/kanbanViews';

export function useKanbanViews(): KanbanViewDescriptor[] {
  const catalog = usePluginHostContributions();
  const boardStyle = useKanbanBoardStyle();
  return useMemo(
    () => kanbanViewsForBoardStyle(kanbanViewsFromCatalog(catalog), boardStyle),
    [boardStyle, catalog]
  );
}
