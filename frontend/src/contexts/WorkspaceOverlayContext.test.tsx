import { fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  useWorkspaceOverlay,
  WorkspaceOverlayProvider,
} from './WorkspaceOverlayContext';

function MenuTrigger() {
  const { setTabCreationMenuOpen } = useWorkspaceOverlay();

  return (
    <button type="button" onClick={() => setTabCreationMenuOpen(true)}>
      Open menu
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
  onOcclusionChange: (occluded: boolean) => void;
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
    expect(onOcclusionChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(onOcclusionChange).toHaveBeenLastCalledWith(true);
    expect(
      screen.getByLabelText('native surface bridge renders')
    ).toHaveTextContent('1');
    expect(screen.getByLabelText('workspace renders')).toHaveTextContent('1');
  });
});
