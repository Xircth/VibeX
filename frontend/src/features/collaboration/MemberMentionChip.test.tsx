import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemberMentionChip } from './MemberMentionChip';

describe('MemberMentionChip', () => {
  it('stores avatar color on a CSS variable instead of the name color', () => {
    render(
      <MemberMentionChip
        nickname="@小A"
        avatar={{
          color: '#c2410c',
          shape: 'circle',
          expression: 'neutral',
        }}
      />
    );

    const chip = screen.getByTestId('collaboration-member-mention-chip-小A');
    expect(chip.style.getPropertyValue('--member-mention-color')).toBe(
      '#c2410c'
    );
    const name = chip.querySelector('.collaboration-member-mention-name');
    expect(name).not.toBeNull();
    expect((name as HTMLElement).style.color).toBe('');
    expect(name).toHaveTextContent('小A');
  });

  it('renders @全体成员 as bold @全体成员 without a bot avatar or avatar color', () => {
    render(<MemberMentionChip nickname="@全体成员" />);

    const chip = screen.getByTestId(
      'collaboration-member-mention-chip-全体成员'
    );
    expect(chip).toHaveAttribute('data-mention-all', 'true');
    expect(chip.style.getPropertyValue('--member-mention-color')).toBe('');
    expect(
      chip.querySelector('.collaboration-member-mention-avatar')
    ).toBeNull();
    const name = chip.querySelector('.collaboration-member-mention-name');
    expect(name).not.toBeNull();
    expect(name).toHaveTextContent('@全体成员');
  });
});
