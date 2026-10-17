import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_KANBAN_ARRANGEMENT,
  DEFAULT_LAYOUT_ARRANGEMENT,
} from '@/lib/layoutArrangement';
import {
  KanbanLayoutSchematic,
  WorkspaceLayoutSchematic,
} from './LayoutArrangementSchematic';

describe('layout arrangement schematic', () => {
  it('shows the workspace page as ABC columns without a terminal strip or reset', () => {
    render(
      <WorkspaceLayoutSchematic
        value={DEFAULT_LAYOUT_ARRANGEMENT}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText('侧栏面板')).toBeInTheDocument();
    expect(screen.getByLabelText('工作区')).toBeInTheDocument();
    expect(screen.getByLabelText('会话')).toBeInTheDocument();
    expect(screen.queryByLabelText('终端')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '恢复默认' })
    ).not.toBeInTheDocument();
    expect(document.querySelector('.max-w-md')).toBeNull();
  });

  it('shows the kanban page as ABC columns without reset', () => {
    render(
      <KanbanLayoutSchematic
        value={DEFAULT_KANBAN_ARRANGEMENT}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText('会话列表')).toBeInTheDocument();
    expect(screen.getByLabelText('会话监控')).toBeInTheDocument();
    expect(screen.getByLabelText('会话执行')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '恢复默认' })
    ).not.toBeInTheDocument();
    expect(document.querySelector('.max-w-md')).toBeNull();
  });
});
