import { useKanbanViewContributions } from '@vibex/plugin-sdk';
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
  const sdkViews = useKanbanViewContributions();
  const boardStyle = useKanbanBoardStyle();
  return useMemo(
    () =>
      kanbanViewsForBoardStyle(
        kanbanViewsFromCatalog(catalog, sdkViews),
        boardStyle
      ),
    [boardStyle, catalog, sdkViews]
  );
}
