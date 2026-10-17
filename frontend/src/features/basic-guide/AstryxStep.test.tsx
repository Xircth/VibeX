import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AstryxStep, AstryxStepItem } from './AstryxStep';
import { AstryxStepper, AstryxStepperItem } from './AstryxStepper';

describe('AstryxStep', () => {
  it('marks the current step for the three-step guide', () => {
    render(
      <AstryxStep current={1} aria-label="基础引导步骤">
        <AstryxStepItem>创建或选择项目</AstryxStepItem>
        <AstryxStepItem>进入工作区并创建会话</AstryxStepItem>
        <AstryxStepItem>熟悉页面构成</AstryxStepItem>
      </AstryxStep>
    );

    const list = screen.getByRole('list', { name: '基础引导步骤' });
    const items = list.querySelectorAll('li');
    expect(items[0]).toHaveAttribute('data-status', 'completed');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).toHaveAttribute('data-status', 'upcoming');
    expect(items[0].querySelector('[data-indicator="done"]')).toBeTruthy();
    expect(items[1].querySelector('[data-indicator="radio"]')).toBeTruthy();
    expect(items[2].querySelector('[data-indicator="idle"]')).toBeTruthy();
  });

  it('renders a title and description for each step', () => {
    render(
      <AstryxStep current={0} aria-label="基础引导步骤">
        <AstryxStepItem description="用一个文件夹隔离会话与工作状态">
          创建或选择项目
        </AstryxStepItem>
        <AstryxStepItem description="选择 Agent 并发送第一条消息">
          进入工作区并创建会话
        </AstryxStepItem>
        <AstryxStepItem description="了解侧栏、看板和计量统计">
          熟悉页面构成
        </AstryxStepItem>
      </AstryxStep>
    );

    const items = screen.getByRole('list').querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0]?.querySelector('.astryx-step__label')).toHaveTextContent(
      '创建或选择项目'
    );
    expect(
      items[0]?.querySelector('.astryx-step__description')
    ).toHaveTextContent('用一个文件夹隔离会话与工作状态');
    expect(items[1]?.querySelector('.astryx-step__label')).toHaveTextContent(
      '进入工作区并创建会话'
    );
    expect(
      items[1]?.querySelector('.astryx-step__description')
    ).toHaveTextContent('选择 Agent 并发送第一条消息');
    expect(items[2]?.querySelector('.astryx-step__label')).toHaveTextContent(
      '熟悉页面构成'
    );
    expect(
      items[2]?.querySelector('.astryx-step__description')
    ).toHaveTextContent('了解侧栏、看板和计量统计');
  });
});

describe('AstryxStepper', () => {
  it('keeps ACP progress to download / install / check', () => {
    render(
      <AstryxStepper current={0} aria-label="ACP 安装进度">
        <AstryxStepperItem>下载</AstryxStepperItem>
        <AstryxStepperItem>安装</AstryxStepperItem>
        <AstryxStepperItem>检查</AstryxStepperItem>
      </AstryxStepper>
    );

    expect(screen.getByLabelText('ACP 安装进度')).toBeInTheDocument();
    expect(screen.getByText('下载')).toBeInTheDocument();
    expect(screen.getByText('安装')).toBeInTheDocument();
    expect(screen.getByText('检查')).toBeInTheDocument();
  });
});
