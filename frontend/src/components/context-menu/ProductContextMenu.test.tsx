import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProductContextMenu } from './ProductContextMenu';

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
}));

const items = [
  {
    type: 'submenu' as const,
    id: 'auto-sort',
    label: '自动排序',
    children: [
      { id: 'sort-name', label: '名称', onSelect: () => undefined },
      { id: 'sort-agent', label: 'Agent', onSelect: () => undefined },
    ],
  },
];

describe('ProductContextMenu submenu', () => {
  it('keeps the submenu open when the pointer crosses the hover bridge', () => {
    render(
      <ProductContextMenu
        x={20}
        y={20}
        items={items}
        onClose={() => undefined}
      />
    );

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '自动排序' }));
    expect(screen.getByRole('menuitem', { name: '名称' })).toBeTruthy();

    fireEvent.mouseEnter(screen.getByTestId('product-context-submenu-bridge'));
    expect(screen.getByRole('menuitem', { name: 'Agent' })).toBeTruthy();
  });
});
