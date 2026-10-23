import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CrossChatNoticeLine, MessageReceiptCheck } from './MessageReceiptCheck';
import { MemberMention } from './MemberMention';
import {
  crossChatNoticesFor,
  receiptCheckState,
  receiptState,
  type DeliveryReceipt,
} from './spaceModel';

const r = (state: string, extra: Partial<DeliveryReceipt> = {}): DeliveryReceipt =>
  ({ conversation_id: 'c', nickname: 'B', delivered: 'queued', state, ...extra }) as DeliveryReceipt;

describe('receipt states', () => {
  it('maps backend states to check states', () => {
    expect(receiptCheckState([r('queued')])).toBe('sent');
    expect(receiptCheckState([r('processing')])).toBe('delivered');
    expect(receiptCheckState([r('replied')])).toBe('delivered');
    expect(receiptCheckState([r('limit_reached')])).toBe('limited');
    expect(receiptCheckState([r('replied'), r('queued')])).toBe('sent');
    expect(receiptCheckState([])).toBeNull();
    expect(receiptState(r('replied'))).toBe('replied');
  });

  it('renders single vs double check inside bubble', () => {
    const { rerender } = render(<MessageReceiptCheck receipts={[r('queued')]} />);
    expect(screen.getByTestId('collaboration-receipt-check').dataset.state).toBe('sent');
    rerender(<MessageReceiptCheck receipts={[r('processing')]} />);
    expect(screen.getByTestId('collaboration-receipt-check').dataset.state).toBe('delivered');
    rerender(<MessageReceiptCheck receipts={[r('limit_reached')]} />);
    expect(screen.getByTestId('collaboration-receipt-check').dataset.state).toBe('limited');
    expect(screen.queryByText(/已收到/)).toBeNull();
  });
});

describe('member mention chip + cross DM lines', () => {
  it('renders avatar + bold colored name', () => {
    render(<MemberMention nickname="小明" avatar={{ color: '#3366ff', shape: 'round', expression: 'smile' } as never} />);
    const chip = screen.getByTestId('member-mention');
    expect(chip.querySelector('.member-mention-avatar')).not.toBeNull();
    expect(chip.querySelector('.member-mention-name')?.textContent).toContain('小明');
  });

  it('builds cross-DM notices for sender and receiver', () => {
    const a = crossChatNoticesFor('A', { from: 'A', to: 'B', replied: true });
    const b = crossChatNoticesFor('B', { from: 'A', to: 'B', replied: true });
    render(<>{[...a, ...b].map((n, i) => <CrossChatNoticeLine key={i} notice={n} candidates={[]} />)}</>);
    const lines = screen.getAllByTestId('collaboration-cross-chat-notice').map((el) => el.textContent);
    expect(lines[0]).toMatch(/已发消息给.*B/);
    expect(lines[1]).toMatch(/已收到.*B.*的消息/);
    expect(lines[2]).toMatch(/已收到.*A.*的消息/);
  });
});
