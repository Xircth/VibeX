import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionHubMonitor } from './SessionHubMonitor';

vi.mock('@/components/kanban/KanbanSessionConversationView', () => ({
  KanbanSessionConversationView: () => (
    <div data-testid="session-conversation" />
  ),
}));

function createMonitorSession(): KanbanProjectSessionRecord {
  return {
    id: 'session-1',
    fullName: '技术重构可行性',
    updatedAt: '2026-08-08T08:00:00.000Z',
    isErrored: false,
    workspace: { id: 'workspace-1' },
  } as KanbanProjectSessionRecord;
}

describe('SessionHubMonitor', () => {
  it('uses the full monitor area for session cards when monitoring is active', () => {
    const onOpenInExecutionArea = vi.fn();
    const session = createMonitorSession();

    render(
      <TooltipProvider>
        <SessionHubMonitor
          monitorRecords={[session]}
          canUseRightPanelForSessions={true}
          onOpenInExecutionArea={onOpenInExecutionArea}
          onCancelMonitor={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.queryByText('会话监控区')).not.toBeInTheDocument();
    expect(screen.queryByText('1 / 4')).not.toBeInTheDocument();
    expect(screen.getByText('技术重构可行性')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '移入执行区' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '取消监控' })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '移入执行区' }));

    expect(onOpenInExecutionArea).toHaveBeenCalledWith(session);
  });

  it('keeps the monitor label as empty-state context', () => {
    render(
      <TooltipProvider>
        <SessionHubMonitor
          monitorRecords={[]}
          canUseRightPanelForSessions={true}
          onOpenInExecutionArea={vi.fn()}
          onCancelMonitor={vi.fn()}
        />
      </TooltipProvider>
    );

    expect(screen.getByText('会话监控区')).toBeInTheDocument();
    expect(
      screen.getByText('点击左侧会话即可在右侧栏或监控区中展开。')
    ).toBeInTheDocument();
  });
});
