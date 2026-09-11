import { fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useWorkspaceOverlay,
  WorkspaceOverlayProvider,
  type NativeSurfaceOcclusion,
} from './WorkspaceOverlayContext';

function MenuTrigger() {
  const { setTabCreationMenuOpen } = useWorkspaceOverlay();

  return (
    <button type="button" onClick={() => setTabCreationMenuOpen(true)}>
      Open menu
    </button>
  );
}

function HtmlOverlayTrigger() {
  const { setHtmlOverlayOpen } = useWorkspaceOverlay();

  return (
    <button type="button" onClick={() => setHtmlOverlayOpen(true)}>
      Open select
    </button>
  );
}

function WorkspaceShell() {
  const renderCount = useRef(0);
  renderCount.current += 1;
  return <output aria-label="workspace renders">{renderCount.current}</output>;
}

function NativeSurfaceBridge({
  onOcclusionChange,
}: {
  onOcclusionChange: (occluded: NativeSurfaceOcclusion) => void;
}) {
  const { subscribeNativeSurfaceOcclusion } = useWorkspaceOverlay();
  const renderCount = useRef(0);
  renderCount.current += 1;

  useLayoutEffect(
    () => subscribeNativeSurfaceOcclusion(onOcclusionChange),
    [onOcclusionChange, subscribeNativeSurfaceOcclusion]
  );

  return (
    <output aria-label="native surface bridge renders">
      {renderCount.current}
    </output>
  );
}

describe('WorkspaceOverlayProvider', () => {
  it('updates native-surface occlusion without rerendering unrelated workspace content', () => {
    const onOcclusionChange = vi.fn();

    render(
      <WorkspaceOverlayProvider>
        <WorkspaceShell />
        <MenuTrigger />
        <NativeSurfaceBridge onOcclusionChange={onOcclusionChange} />
      </WorkspaceOverlayProvider>
    );

    expect(screen.getByLabelText('workspace renders')).toHaveTextContent('1');
    expect(
      screen.getByLabelText('native surface bridge renders')
    ).toHaveTextContent('1');
    expect(onOcclusionChange).toHaveBeenLastCalledWith({
      hide: false,
      rects: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(onOcclusionChange).toHaveBeenLastCalledWith({
      hide: true,
      rects: [],
    });
    expect(
      screen.getByLabelText('native surface bridge renders')
    ).toHaveTextContent('1');
    expect(screen.getByLabelText('workspace renders')).toHaveTextContent('1');
  });

  it('occludes native surfaces while an HTML overlay such as a select is open', () => {
    const onOcclusionChange = vi.fn();

    render(
      <WorkspaceOverlayProvider>
        <HtmlOverlayTrigger />
        <NativeSurfaceBridge onOcclusionChange={onOcclusionChange} />
      </WorkspaceOverlayProvider>
    );

    expect(onOcclusionChange).toHaveBeenLastCalledWith({
      hide: false,
      rects: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open select' }));
    expect(onOcclusionChange).toHaveBeenLastCalledWith({
      hide: true,
      rects: [],
    });
  });

  it('reports the dropdown rectangle instead of hiding the whole surface', () => {
    const onOcclusionChange = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.getAttribute('role') === 'menu') {
          return {
            x: 620,
            y: 40,
            top: 40,
            left: 620,
            right: 800,
            bottom: 260,
            width: 180,
            height: 220,
            toJSON: () => ({}),
          };
        }
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        };
      }
    );

    render(
      <WorkspaceOverlayProvider>
        <NativeSurfaceBridge onOcclusionChange={onOcclusionChange} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button">Open app menu</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Back to home</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </WorkspaceOverlayProvider>
    );

    expect(onOcclusionChange).toHaveBeenLastCalledWith({
      hide: false,
      rects: [],
    });
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Open app menu' }),
      { button: 0 }
    );
    expect(
      screen.getByRole('menuitem', { name: 'Back to home' })
    ).toBeVisible();
    expect(onOcclusionChange).toHaveBeenLastCalledWith({
      hide: false,
      rects: [{ x: 620, y: 40, width: 180, height: 220 }],
    });

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      })
    );
    fireEvent.resize(window);
    expect(onOcclusionChange).toHaveBeenLastCalledWith({
      hide: false,
      rects: [{ x: 620, y: 40, width: 180, height: 220 }],
    });
    vi.restoreAllMocks();
  });
});
