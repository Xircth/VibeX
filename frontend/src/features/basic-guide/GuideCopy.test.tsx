import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GuideCopy } from './GuideCopy';

describe('GuideCopy', () => {
  it('renders **markers** as strong text', () => {
    render(<GuideCopy text="可在**设置-常规**中点击**重新开始基础引导**" />);
    expect(screen.getByText('设置-常规').tagName).toBe('STRONG');
    expect(screen.getByText('重新开始基础引导').tagName).toBe('STRONG');
  });
});
