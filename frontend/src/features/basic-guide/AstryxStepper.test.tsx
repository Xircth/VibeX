import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AstryxStepper, AstryxStepperItem } from './AstryxStepper';

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
