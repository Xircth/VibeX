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

  it('runs a submenu action on click and still reveals children on hover', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <ProductContextMenu
        x={20}
        y={20}
        onClose={onClose}
        items={[
          {
            type: 'submenu',
            id: 'new-terminal',
            label: '终端',
            onSelect,
            children: [
              { id: 'shell-cmd', label: 'CMD', onSelect: () => undefined },
            ],
          },
        ]}
      />
    );

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '终端' }));
    expect(screen.getByRole('menuitem', { name: 'CMD' })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: '终端' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('remains open and does not auto-dismiss on scroll or blur events', () => {
    const onClose = vi.fn();
    render(
      <ProductContextMenu
        x={50}
        y={50}
        onClose={onClose}
        items={[
          { id: 'test-item', label: '测试项目', onSelect: () => undefined },
        ]}
      />
    );

    expect(
      screen.getByRole('menuitem', { name: '测试项目' })
    ).toBeInTheDocument();

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('blur'));

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole('menuitem', { name: '测试项目' })
    ).toBeInTheDocument();
  });

  it('closes strictly on Escape or clicking outside', () => {
    const onClose = vi.fn();
    render(
      <div>
        <div data-testid="outside-area">Outside</div>
        <ProductContextMenu
          x={50}
          y={50}
          onClose={onClose}
          items={[
            { id: 'test-item', label: '测试项目', onSelect: () => undefined },
          ]}
        />
      </div>
    );

    // Escape closes
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Pointerdown outside closes
    fireEvent.pointerDown(screen.getByTestId('outside-area'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('enforces global singleton exclusivity by closing previous menu when new menu mounts', () => {
    const onCloseFirst = vi.fn();
    const onCloseSecond = vi.fn();

    const { unmount: unmountFirst } = render(
      <ProductContextMenu
        x={50}
        y={50}
        onClose={onCloseFirst}
        items={[
          { id: 'first-item', label: '第一个菜单', onSelect: () => undefined },
        ]}
      />
    );

    expect(onCloseFirst).not.toHaveBeenCalled();

    // Render second menu
    render(
      <ProductContextMenu
        x={100}
        y={100}
        onClose={onCloseSecond}
        items={[
          { id: 'second-item', label: '第二个菜单', onSelect: () => undefined },
        ]}
      />
    );

    // First menu onClose should have been called automatically to dismiss
    expect(onCloseFirst).toHaveBeenCalledOnce();
    expect(onCloseSecond).not.toHaveBeenCalled();

    unmountFirst();
  });

  it('applies white background, border, no shadow, and increased font size', () => {
    render(
      <ProductContextMenu
        x={50}
        y={50}
        onClose={() => undefined}
        items={[
          { id: 'style-item', label: '样式检查', onSelect: () => undefined },
        ]}
      />
    );

    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass(
      'bg-white',
      'border',
      'border-border',
      'shadow-none',
      'text-[13px]'
    );
    expect(menu).not.toHaveClass('tahoe-popover');

    const item = screen.getByRole('menuitem', { name: '样式检查' });
    expect(item).toHaveClass('text-[13px]');
  });

  it('keeps at most one submenu open when rapidly sweeping across multiple sibling submenu items', () => {
    render(
      <ProductContextMenu
        x={20}
        y={20}
        onClose={() => undefined}
        items={[
          {
            type: 'submenu',
            id: 'close-group',
            label: '关闭',
            children: [
              {
                id: 'close-others',
                label: '关闭其他',
                onSelect: () => undefined,
              },
            ],
          },
          {
            type: 'submenu',
            id: 'split-group',
            label: '拆分',
            children: [
              {
                id: 'split-down',
                label: '向下拆分',
                onSelect: () => undefined,
              },
            ],
          },
          {
            type: 'submenu',
            id: 'new-group',
            label: '新建',
            children: [
              { id: 'new-note', label: '笔记', onSelect: () => undefined },
            ],
          },
          {
            type: 'submenu',
            id: 'sort-group',
            label: '排序',
            children: [
              {
                id: 'sort-by-name',
                label: '按名称排序',
                onSelect: () => undefined,
              },
            ],
          },
          {
            id: 'plain-action',
            label: '普通操作',
            onSelect: () => undefined,
          },
        ]}
      />
    );

    const closeTrigger = screen.getByRole('menuitem', { name: '关闭' });
    const splitTrigger = screen.getByRole('menuitem', { name: '拆分' });
    const newTrigger = screen.getByRole('menuitem', { name: '新建' });
    const sortTrigger = screen.getByRole('menuitem', { name: '排序' });
    const plainItem = screen.getByRole('menuitem', { name: '普通操作' });

    fireEvent.mouseEnter(closeTrigger);
    expect(
      screen.getByRole('menuitem', { name: '关闭其他' })
    ).toBeInTheDocument();

    fireEvent.mouseLeave(closeTrigger);
    fireEvent.mouseEnter(splitTrigger);
    expect(screen.queryByRole('menuitem', { name: '关闭其他' })).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: '向下拆分' })
    ).toBeInTheDocument();

    fireEvent.mouseLeave(splitTrigger);
    fireEvent.mouseEnter(newTrigger);
    expect(screen.queryByRole('menuitem', { name: '向下拆分' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '笔记' })).toBeInTheDocument();

    fireEvent.mouseLeave(newTrigger);
    fireEvent.mouseEnter(sortTrigger);
    expect(screen.queryByRole('menuitem', { name: '笔记' })).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: '按名称排序' })
    ).toBeInTheDocument();
    expect(
      screen.getAllByTestId('product-context-submenu-bridge')
    ).toHaveLength(1);

    // Entering a regular non-submenu item immediately closes the active submenu
    fireEvent.mouseLeave(sortTrigger);
    fireEvent.mouseEnter(plainItem);
    expect(screen.queryByRole('menuitem', { name: '按名称排序' })).toBeNull();
    expect(
      screen.queryAllByTestId('product-context-submenu-bridge')
    ).toHaveLength(0);
  });
});
