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

  it('supplies the standard title and summary for compact calls', async () => {
    render(<Toaster />);

    act(() => {
      toast.success('设置已保存');
    });

    expect(await screen.findByText('操作已完成')).toBeInTheDocument();
    expect(screen.getByText('设置已保存')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('vu-toast-surface');
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
    const disclosure = screen.getByRole('button', { name: '查看详细信息' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Codex CLI')).not.toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
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
