import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionCanvasDock } from './SessionCanvasDock';

vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe('SessionCanvasDock', () => {
  it('creates a group from plus and shows icons on import options', async () => {
    const user = userEvent.setup();
    const onCreateGroup = vi.fn();
    render(
      <SessionCanvasDock
        selectedCount={0}
        selectedExpanded={false}
        onCreateGroup={onCreateGroup}
        onImportByProject={vi.fn()}
        onImportByRecent={vi.fn()}
        onImportByAgent={vi.fn()}
        onFitView={vi.fn()}
        onAutoArrange={vi.fn()}
        onExpandSelection={vi.fn()}
        onCollapseSelection={vi.fn()}
        onDeleteSelection={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '创建分组' }));
    expect(onCreateGroup).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '导入会话' }));
    const project = await screen.findByRole('menuitem', { name: '项目导入' });
    const recent = screen.getByRole('menuitem', { name: '最近时间导入' });
    const agent = screen.getByRole('menuitem', { name: 'Agent 导入' });
    expect(project.querySelector('svg')).toBeTruthy();
    expect(recent.querySelector('svg')).toBeTruthy();
    expect(agent.querySelector('svg')).toBeTruthy();
  });
});
