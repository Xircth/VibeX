import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionCanvasDock } from './SessionCanvasDock';

vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function renderDock({
  onCreateGroup = vi.fn(),
  onCreateSession = vi.fn(),
}: {
  onCreateGroup?: ReturnType<typeof vi.fn>;
  onCreateSession?: ReturnType<typeof vi.fn>;
} = {}) {
  render(
    <SessionCanvasDock
      selectedCount={0}
      selectedExpanded={false}
      onCreateGroup={onCreateGroup}
      onCreateSession={onCreateSession}
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
  return { onCreateGroup, onCreateSession };
}

describe('SessionCanvasDock', () => {
  it('opens create options from plus and keeps icons on import options', async () => {
    const user = userEvent.setup();
    const { onCreateGroup, onCreateSession } = renderDock();

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '空白分组' }));
    expect(onCreateGroup).toHaveBeenCalledTimes(1);
    expect(onCreateSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '新建' }));
    await user.click(await screen.findByRole('menuitem', { name: '新建会话' }));
    expect(onCreateSession).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '导入会话' }));
    const project = await screen.findByRole('menuitem', { name: '项目导入' });
    const recent = screen.getByRole('menuitem', { name: '最近时间导入' });
    const agent = screen.getByRole('menuitem', { name: 'Agent 导入' });
    expect(project.querySelector('svg')).toBeTruthy();
    expect(recent.querySelector('svg')).toBeTruthy();
    expect(agent.querySelector('svg')).toBeTruthy();
  });
});
