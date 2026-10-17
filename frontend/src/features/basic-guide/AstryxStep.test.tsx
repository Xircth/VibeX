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
