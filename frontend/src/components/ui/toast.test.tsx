import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { Toaster, toast } from './toast';

describe('unified toast', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  afterEach(() => {
    act(() => {
      toast.dismiss();
    });
  });

  it('uses the compact message as the title', async () => {
    render(<Toaster />);

    act(() => {
      toast.success('设置已保存');
    });

    const title = await screen.findByText('设置已保存');
    expect(title).toBeInTheDocument();
    expect(screen.queryByText('操作已完成')).not.toBeInTheDocument();
    expect(title.closest('.vu-toast-surface')).toHaveClass('vu-toast-surface');
    expect(
      screen.queryByRole('button', { name: '查看详情' })
    ).not.toBeInTheDocument();
  });

  it('moves a trailing technical suffix on errors into details', async () => {
    render(<Toaster />);

    act(() => {
      toast.error('另一个程序正在使用此文件，进程无法访问。 (os error 32)');
    });

    expect(
      await screen.findByText('另一个程序正在使用此文件，进程无法访问。')
    ).toBeInTheDocument();
    expect(screen.queryByText(/os error 32/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByText('os error 32')).toHaveClass(
      'vu-toast-detail-copy-mono'
    );
  });

  it('keeps ordinary parenthetical copy in the warning title', async () => {
    render(<Toaster />);

    act(() => {
      toast.warning('保存失败（请检查网络）');
    });

    expect(
      await screen.findByText('保存失败（请检查网络）')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '查看详情' })
    ).not.toBeInTheDocument();
  });

  it('keeps a non-technical parenthetical in the error title', async () => {
    render(<Toaster />);

    act(() => {
      toast.error('保存失败 (try again)');
    });

    expect(await screen.findByText('保存失败 (try again)')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '查看详情' })
    ).not.toBeInTheDocument();
  });

  it('moves a trailing path on warnings into details', async () => {
    render(<Toaster />);

    act(() => {
      toast.warning('无法打开 (C:\\temp\\lock.dat)');
    });

    expect(await screen.findByText('无法打开')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByText('C:\\temp\\lock.dat')).toHaveClass(
      'vu-toast-detail-copy-mono'
    );
  });

  it('keeps a caller description after the extracted suffix', async () => {
    render(<Toaster />);

    act(() => {
      toast.error('无法写入文件。 (os error 32)', {
        description: '目标文件仍被占用。',
      });
    });

    expect(await screen.findByText('无法写入文件。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const rows = document.querySelectorAll('.vu-toast-detail-row');
    expect(rows[0]).toHaveTextContent('os error 32');
    expect(rows[1]).toHaveTextContent('目标文件仍被占用。');
  });

  it('leaves a technical suffix on success in the title', async () => {
    render(<Toaster />);

    act(() => {
      toast.success('已完成 (os error 32)');
    });

    expect(await screen.findByText('已完成 (os error 32)')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '查看详情' })
    ).not.toBeInTheDocument();
  });

  it('folds description into expandable details', async () => {
    render(<Toaster />);

    act(() => {
      toast.error('无法打开外部终端', {
        description: 'ENOENT: code.exe',
      });
    });

    expect(await screen.findByText('无法打开外部终端')).toBeInTheDocument();
    expect(screen.queryByText('ENOENT: code.exe')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByText('ENOENT: code.exe')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起详情' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('keeps details independent from actions and dismisses after acting', async () => {
    const action = vi.fn();
    render(<Toaster />);

    act(() => {
      toast.warning('依赖需要更新', {
        description: '可在 VibeX 内完成更新。',
        details: [
          {
            title: 'Codex CLI',
            description: '/Users/sean/.local/bin/codex · 0.139.0',
            mono: true,
          },
        ],
        action: { label: '更新', onClick: action },
      });
    });

    expect(await screen.findByText('依赖需要更新')).toBeInTheDocument();
    expect(
      screen.queryByText('可在 VibeX 内完成更新。')
    ).not.toBeInTheDocument();
    const disclosure = screen.getByRole('button', { name: '查看详情' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Codex CLI')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('可在 VibeX 内完成更新。')).toBeInTheDocument();
    expect(screen.getByText('Codex CLI')).toBeInTheDocument();
    expect(screen.getByText(/\.local\/bin\/codex/)).toHaveClass(
      'vu-toast-detail-copy-mono'
    );

    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.queryByText('依赖需要更新')).not.toBeInTheDocument();
  });

  it('updates a loading toast in place by id', async () => {
    render(<Toaster />);

    let id: string | number = '';
    act(() => {
      id = toast.loading('正在导出');
    });
    const loading = await screen.findByText('正在导出');
    const loadingItem = loading.closest('.vu-toast-host');

    act(() => {
      toast.success('导出完成', { id });
    });

    const completed = await screen.findByText('导出完成');
    expect(completed.closest('.vu-toast-surface')).toHaveAttribute(
      'data-kind',
      'success'
    );
    expect(completed.closest('.vu-toast-host')).toBe(loadingItem);
  });

  it('keeps only the three newest notifications', () => {
    render(<Toaster />);

    act(() => {
      toast.info('第一条');
      toast.info('第二条');
      toast.info('第三条');
      toast.info('第四条');
    });

    expect(screen.queryByText('第一条')).not.toBeInTheDocument();
    expect(screen.getByText('第二条')).toBeInTheDocument();
    expect(screen.getByText('第三条')).toBeInTheDocument();
    expect(screen.getByText('第四条')).toBeInTheDocument();
    expect(document.querySelectorAll('.vu-toast-host')).toHaveLength(3);
  });
});
