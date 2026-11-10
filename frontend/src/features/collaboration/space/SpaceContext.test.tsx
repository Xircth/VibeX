import { memo, useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationSpaceRuntime } from './CollaborationSpaceRuntime';

let setMockDraft: ((next: string) => void) | null = null;
let setMockCursor: ((next: { x: number; y: number } | null) => void) | null =
  null;
let setMockBottom: ((next: boolean) => void) | null = null;
let setMockCreateOpen: ((next: boolean) => void) | null = null;

vi.mock('./CollaborationSpaceRuntime', async () => {
  const React = await import('react');
  return {
    useCollaborationSpaceRuntime: () => {
      const [draft, setDraft] = React.useState('');
      const [pointerDragCursor, setPointerDragCursor] = React.useState<{
        x: number;
        y: number;
      } | null>(null);
      const [isAtThreadBottom, setIsAtThreadBottom] = React.useState(true);
      const [createOpen, setCreateOpen] = React.useState(false);
      setMockDraft = setDraft;
      setMockCursor = setPointerDragCursor;
      setMockBottom = setIsAtThreadBottom;
      setMockCreateOpen = setCreateOpen;
      return {
        draft,
        setDraft,
        pointerDragCursor,
        setPointerDragCursor,
        isAtThreadBottom,
        setIsAtThreadBottom,
        createOpen,
        hasActiveOverlay: createOpen,
        selectedId: 'space-1',
        renderMessageAreaOverlay: () =>
          createOpen ? <div data-testid="overlay-dialog">open</div> : null,
        renderSupervisorSlot: () => (
          <div data-testid="supervisor-slot">slot</div>
        ),
      } as unknown as CollaborationSpaceRuntime;
    },
  };
});

import {
  CollaborationSpaceProvider,
  useCollaborationSpacePick,
} from './SpaceContext';

const SIDEBAR_KEYS = ['selectedId', 'renderSupervisorSlot'] as const;
const OVERLAY_KEYS = [
  'createOpen',
  'hasActiveOverlay',
  'renderMessageAreaOverlay',
] as const;
const COMPOSER_KEYS = ['draft'] as const;
const DRAG_KEYS = ['pointerDragCursor'] as const;

describe('useCollaborationSpacePick render isolation', () => {
  it('isolates subscribers (including render* closures) from high-frequency updates to unpicked keys and refreshes render* identity when picked keys change', () => {
    let sidebarRenders = 0;
    let overlayRenders = 0;
    let composerRenders = 0;
    let dragRenders = 0;
    const seenOverlayRenderFns: Array<() => unknown> = [];

    const SidebarProbe = memo(function SidebarProbe() {
      const { selectedId, renderSupervisorSlot } =
        useCollaborationSpacePick(SIDEBAR_KEYS);
      useEffect(() => {
        sidebarRenders += 1;
      });
      return (
        <div data-testid="sidebar-probe">
          {selectedId}
          {renderSupervisorSlot()}
        </div>
      );
    });

    const OverlayProbe = memo(function OverlayProbe() {
      const { renderMessageAreaOverlay } =
        useCollaborationSpacePick(OVERLAY_KEYS);
      seenOverlayRenderFns.push(renderMessageAreaOverlay);
      useEffect(() => {
        overlayRenders += 1;
      });
      return <>{renderMessageAreaOverlay()}</>;
    });

    const ComposerProbe = memo(function ComposerProbe() {
      const { draft } = useCollaborationSpacePick(COMPOSER_KEYS);
      useEffect(() => {
        composerRenders += 1;
      });
      return <div data-testid="composer-probe">{draft}</div>;
    });

    const DragProbe = memo(function DragProbe() {
      const { pointerDragCursor } = useCollaborationSpacePick(DRAG_KEYS);
      useEffect(() => {
        dragRenders += 1;
      });
      return (
        <div data-testid="drag-probe">
          {pointerDragCursor
            ? `${pointerDragCursor.x},${pointerDragCursor.y}`
            : 'idle'}
        </div>
      );
    });

    render(
      <CollaborationSpaceProvider workspaceId="ws-1">
        <SidebarProbe />
        <OverlayProbe />
        <ComposerProbe />
        <DragProbe />
      </CollaborationSpaceProvider>
    );

    expect(sidebarRenders).toBe(1);
    expect(overlayRenders).toBe(1);
    expect(composerRenders).toBe(1);
    expect(dragRenders).toBe(1);
    expect(screen.queryByTestId('overlay-dialog')).toBeNull();

    act(() => {
      setMockDraft?.('hello');
    });
    expect(screen.getByTestId('composer-probe').textContent).toBe('hello');
    expect(composerRenders).toBe(2);
    expect(sidebarRenders).toBe(1);
    expect(overlayRenders).toBe(1);
    expect(dragRenders).toBe(1);

    act(() => {
      setMockCursor?.({ x: 120, y: 240 });
    });
    expect(screen.getByTestId('drag-probe').textContent).toBe('120,240');
    expect(dragRenders).toBe(2);
    expect(sidebarRenders).toBe(1);
    expect(overlayRenders).toBe(1);
    expect(composerRenders).toBe(2);

    act(() => {
      setMockBottom?.(false);
    });
    expect(sidebarRenders).toBe(1);
    expect(overlayRenders).toBe(1);
    expect(composerRenders).toBe(2);
    expect(dragRenders).toBe(2);

    act(() => {
      setMockCreateOpen?.(true);
    });
    expect(overlayRenders).toBe(2);
    expect(sidebarRenders).toBe(1);
    expect(screen.getByTestId('overlay-dialog').textContent).toBe('open');
    expect(seenOverlayRenderFns).toHaveLength(2);
    expect(seenOverlayRenderFns[0]).not.toBe(seenOverlayRenderFns[1]);
  });
});
