import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { toast } from '@/components/ui/toast';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import {
  SessionCardHoverInfo,
  sessionCardHoverDetails,
} from './SessionCardHoverInfo';

vi.mock('@/vscode/bridge', () => ({
  writeClipboardViaBridge: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function session(
  overrides: Partial<KanbanProjectSessionRecord> = {}
): KanbanProjectSessionRecord {
  return {
    id: 'session-1',
    fullName: '分析下我的项目根目录，是否有不应该存在于根目录中的文件',
    agentId: 'antigravity',
    executor: 'antigravity',
    model: 'gemini-3.8-flash-high',
    workspaceName: 'Main',
    branch: 'master',
    workspace: {
      id: 'workspace-1',
      container_ref: 'C:\\Users\\18190\\Documents\\projects\\VibeX',
      agent_working_dir: null,
    },
    ...overrides,
  } as KanbanProjectSessionRecord;
}

describe('sessionCardHoverDetails', () => {
  it('keeps the full session name and copies project workspace path', () => {
    expect(
      sessionCardHoverDetails(
        session(),
        '分析下我的项目根目录，是否有不应该存在于根目录中的文件',
        { name: 'VibeX', root_path: 'C:\\fallback' }
      )
    ).toEqual({
      name: '分析下我的项目根目录，是否有不应该存在于根目录中的文件',
      agentKey: 'antigravity',
      agentName: 'Google Antigravity',
      model: 'gemini-3.8-flash-high',
      projectName: 'VibeX',
      workspaceLabel: 'Main',
      path: 'C:\\Users\\18190\\Documents\\projects\\VibeX',
    });
  });

  it('falls back to the project root when the workspace has no path', () => {
    expect(
      sessionCardHoverDetails(
        session({
          workspace: {
            id: 'workspace-1',
            container_ref: null,
            agent_working_dir: null,
          } as KanbanProjectSessionRecord['workspace'],
        }),
        '请你进行以下任务',
        {
          name: 'VibeX',
          root_path: 'C:\\Users\\18190\\Documents\\projects\\VibeX',
        }
      ).path
    ).toBe('C:\\Users\\18190\\Documents\\projects\\VibeX');
  });
});

describe('SessionCardHoverInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows name, agent, model, and copyable project fields', () => {
    const details = sessionCardHoverDetails(
      session(),
      '分析下我的项目根目录，是否有不应该存在于根目录中的文件',
      { name: 'VibeX', root_path: 'C:\\fallback' }
    );

    render(<SessionCardHoverInfo {...details} />);

    expect(
      screen.getByTestId('session-card-hover-copy-name')
    ).toHaveTextContent(
      '分析下我的项目根目录，是否有不应该存在于根目录中的文件'
    );
    expect(screen.getByText('Google Antigravity')).toBeInTheDocument();
    expect(screen.getByText('· gemini-3.8-flash-high')).toBeInTheDocument();
    expect(screen.getByText('项目')).toBeInTheDocument();
    expect(
      screen.getByTestId('session-card-hover-copy-project')
    ).toHaveTextContent('VibeX');
    expect(screen.getByText('工作区')).toBeInTheDocument();
    expect(
      screen.getByTestId('session-card-hover-copy-workspace')
    ).toHaveTextContent('Main');
    expect(screen.getByText('路径')).toBeInTheDocument();
    expect(
      screen.getByTestId('session-card-hover-copy-path')
    ).toHaveTextContent('C:\\Users\\18190\\Documents\\projects\\VibeX');
  });

  it('copies the clicked name, project, workspace, and path', () => {
    const details = sessionCardHoverDetails(session(), '请参考附图，对我', {
      name: 'VibeX',
      root_path: 'C:\\fallback',
    });

    render(<SessionCardHoverInfo {...details} />);

    fireEvent.click(screen.getByTestId('session-card-hover-copy-name'));
    fireEvent.click(screen.getByTestId('session-card-hover-copy-project'));
    fireEvent.click(screen.getByTestId('session-card-hover-copy-workspace'));
    fireEvent.click(screen.getByTestId('session-card-hover-copy-path'));

    expect(writeClipboardViaBridge).toHaveBeenNthCalledWith(
      1,
      '请参考附图，对我'
    );
    expect(writeClipboardViaBridge).toHaveBeenNthCalledWith(2, 'VibeX');
    expect(writeClipboardViaBridge).toHaveBeenNthCalledWith(3, 'Main');
    expect(writeClipboardViaBridge).toHaveBeenNthCalledWith(
      4,
      'C:\\Users\\18190\\Documents\\projects\\VibeX'
    );
    expect(toast.success).toHaveBeenCalledWith('已复制会话名称');
    expect(toast.success).toHaveBeenCalledWith('已复制项目');
    expect(toast.success).toHaveBeenCalledWith('已复制工作区');
    expect(toast.success).toHaveBeenCalledWith('已复制路径');
  });
});
