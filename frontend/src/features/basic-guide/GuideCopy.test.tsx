import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GuideCopy } from './GuideCopy';

describe('GuideCopy', () => {
  it('renders **markers** as strong text', () => {
    render(<GuideCopy text="可在**设置-常规**中点击**重新开始基础引导**" />);
    expect(screen.getByText('设置-常规').tagName).toBe('STRONG');
    expect(screen.getByText('重新开始基础引导').tagName).toBe('STRONG');
  });

  it('marks action verbs in green bold', () => {
    render(<GuideCopy text="首先，点击此按钮以创建会话" />);
    expect(screen.getByText('点击')).toHaveClass('basic-guide-action');
    expect(screen.getByText('创建')).toHaveClass('basic-guide-action');
  });

  it('keeps concept nouns as ordinary strong text', () => {
    render(<GuideCopy text="选择一个**项目**" />);
    expect(screen.getByText('选择')).toHaveClass('basic-guide-action');
    expect(screen.getByText('项目').tagName).toBe('STRONG');
    expect(screen.getByText('项目')).not.toHaveClass('basic-guide-action');
  });
});
