import { fireEvent, render, screen } from '@testing-library/react';
import { getPanelData, type DockviewApi } from 'dockview-core';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { syncDockviewGroupRegistry } from '@/utils/dockviewHelpers';
import { installDockviewPointerTabDnd } from '@/utils/dockviewPointerTabDnd';
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

function mockElementDimensions(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
) {
  Object.defineProperty(element, 'offsetWidth', {
    configurable: true,
    value: rect.width,
  });
  Object.defineProperty(element, 'offsetHeight', {
    configurable: true,
    value: rect.height,
  });
  element.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
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

    const title = screen.getByText('笔记');
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

  it('bridges pointer tab drag across editor and session tab bars without triggering native OLE no-drop', () => {
    let api: DockviewApi | undefined;
    let editorGroup: ReturnType<DockviewApi['addGroup']> | undefined;
    let sessionGroup: ReturnType<DockviewApi['addGroup']> | undefined;

    const onReady = (event: DockviewReadyEvent) => {
      api = event.api;
      const notes = event.api.addPanel({
        id: 'notes',
        component: 'panel',
        title: 'Notes',
      });
      editorGroup = notes.group;
      (editorGroup as { id: string }).id = 'group-editor-1';
      syncDockviewGroupRegistry(event.api);
      event.api.addPanel({
        id: 'git',
        component: 'panel',
        title: 'Git',
        position: { referenceGroup: editorGroup, direction: 'within' },
      });

      sessionGroup = event.api.addGroup({
        id: 'group-right',
        direction: 'right',
        referencePanel: notes,
      });
      event.api.addPanel({
        id: 'ai-chat:session-1',
        component: 'panel',
        title: 'Session 1',
        params: { sessionId: 'session-1', agent: 'CLAUDE_CODE' },
        position: { referenceGroup: sessionGroup, direction: 'within' },
      });
    };

    const { container } = render(
      <DockviewReact
        components={{ panel: Panel }}
        defaultTabComponent={WorkspaceDockviewTab}
        onReady={onReady}
      />
    );

    const bridge = installDockviewPointerTabDnd(container);

    try {
      const notesTitle = screen.getByText('笔记');
      const notesTab = notesTitle.closest('.dv-tab') as HTMLElement | null;
      const sessionSurface = container.querySelector(
        '[data-session-tab="true"]'
      ) as HTMLElement | null;
      const sessionTab = sessionSurface?.closest(
        '.dv-tab'
      ) as HTMLElement | null;
      expect(notesTab).toBeTruthy();
      expect(sessionTab).toBeTruthy();
      if (!notesTab || !sessionTab || !editorGroup || !sessionGroup) {
        throw new Error('expected tabs and groups to be mounted');
      }

      mockElementDimensions(notesTab, {
        left: 20,
        top: 4,
        width: 90,
        height: 28,
      });
      mockElementDimensions(sessionTab, {
        left: 520,
        top: 4,
        width: 64,
        height: 28,
      });

      const originalElementFromPoint = document.elementFromPoint;
      document.elementFromPoint = vi.fn((x: number) => {
        if (x >= 500) return sessionTab;
        return notesTab;
      });

      try {
        fireEvent.pointerDown(notesTitle, {
          button: 0,
          buttons: 1,
          pointerId: 1,
          clientX: 40,
          clientY: 16,
        });

        fireEvent.pointerMove(window, {
          buttons: 1,
          pointerId: 1,
          clientX: 60,
          clientY: 16,
        });

        expect(document.body.style.cursor).toBe('grabbing');
        expect(
          document.body.querySelector('[data-dockview-tab-drag-ghost="true"]')
        ).toBeTruthy();

        fireEvent.pointerMove(window, {
          buttons: 1,
          pointerId: 1,
          clientX: 540,
          clientY: 16,
        });

        fireEvent.pointerUp(window, {
          button: 0,
          pointerId: 1,
          clientX: 540,
          clientY: 16,
        });

        expect(api?.getPanel('notes')?.group.id).toBe(sessionGroup.id);
        expect(
          document.body.querySelector('[data-dockview-tab-drag-ghost="true"]')
        ).toBeNull();
      } finally {
        document.elementFromPoint = originalElementFromPoint;
      }
    } finally {
      bridge.dispose();
    }
  });
});
