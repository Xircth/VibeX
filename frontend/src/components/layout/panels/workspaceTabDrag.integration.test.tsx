import { fireEvent, render, screen } from '@testing-library/react';
import { getPanelData, type DockviewApi } from 'dockview-core';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkspaceDockviewTab } from './PanelRegistry';

vi.mock('./workspaceTabContextMenu', () => ({
  useWorkspaceEditorTabMenu: () => null,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
    ResizeObserverStub;
});

function Panel() {
  return <div />;
}

describe('workspace tab drag', () => {
  it('starts a dockview drag from the tab title and can land in another column', () => {
    let api: DockviewApi | undefined;
    let reviewGroup: ReturnType<DockviewApi['addGroup']> | undefined;
    const onReady = (event: DockviewReadyEvent) => {
      api = event.api;
      const notes = event.api.addPanel({
        id: 'notes',
        component: 'panel',
        title: 'Notes',
      });
      reviewGroup = event.api.addGroup({
        id: 'group-editor-2',
        direction: 'right',
        referencePanel: notes,
      });
      event.api.addPanel({
        id: 'review',
        component: 'panel',
        title: 'Review',
        position: { referenceGroup: reviewGroup, direction: 'within' },
      });
    };

    render(
      <DockviewReact
        components={{ panel: Panel }}
        defaultTabComponent={WorkspaceDockviewTab}
        onReady={onReady}
      />
    );

    const title = screen.getByText('Notes');
    const surface = title.closest('.workspace-tab-surface');
    const tab = surface?.closest('.dv-tab');
    expect(surface).not.toHaveAttribute('draggable');
    expect(tab).toHaveAttribute('draggable', 'true');

    const drag = fireEvent.dragStart(title);
    expect(drag).toBe(true);

    expect(getPanelData()?.panelId).toBe('notes');
    if (!reviewGroup) throw new Error('expected a second editor column');

    api?.getPanel('notes')?.api.moveTo({ group: reviewGroup });

    expect(api?.getPanel('notes')?.group.id).toBe(reviewGroup.id);
    expect(api?.getPanel('review')?.group.id).toBe(reviewGroup.id);
  });
});
