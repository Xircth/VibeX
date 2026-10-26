import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  CollaborationReplyCapsule,
  replyCapsuleText,
} from './CollaborationReplyCapsule';

describe('CollaborationReplyCapsule', () => {
  it('shows a single-line capsule and dismisses on click', () => {
    const onDismiss = vi.fn();
    render(
      <CollaborationReplyCapsule
        text={'  我在你电脑上开了一个新的 PowerShell 窗口  '}
        onDismiss={onDismiss}
      />
    );
    const capsule = screen.getByTestId('collaboration-reply-capsule');
    expect(capsule).toHaveTextContent(
      '我在你电脑上开了一个新的 PowerShell 窗口'
    );
    fireEvent.click(screen.getByRole('button', { name: '取消回复' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('collapses whitespace for the capsule text', () => {
    expect(replyCapsuleText('  你好\n世界  ')).toBe('你好 世界');
  });
});
