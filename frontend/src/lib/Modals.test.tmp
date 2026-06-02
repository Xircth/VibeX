import type React from 'react';
import type { NiceModalHocProps } from '@ebay/nice-modal-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineModal, getErrorMessage, type NoProps } from './modals';

const niceModal = vi.hoisted(() => ({
  show: vi.fn(),
  hide: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@ebay/nice-modal-react', () => ({
  default: niceModal,
}));

function dialog<P>(): React.ComponentType<P & NiceModalHocProps> {
  return (() => null) as React.ComponentType<P & NiceModalHocProps>;
}

describe('defineModal', () => {
  beforeEach(() => {
    niceModal.show.mockReset();
    niceModal.hide.mockReset();
    niceModal.remove.mockReset();
  });

  it('attaches static modal helpers to the original component', async () => {
    const component = dialog<{ name: string }>();
    niceModal.show.mockResolvedValue('saved');

    const modal = defineModal<{ name: string }, 'saved'>(component);

    expect(modal).toBe(component);
    await expect(modal.show({ name: 'Ada' })).resolves.toBe('saved');
    expect(niceModal.show).toHaveBeenCalledWith(component, { name: 'Ada' });

    modal.hide();
    modal.remove();
    expect(niceModal.hide).toHaveBeenCalledWith(component);
    expect(niceModal.remove).toHaveBeenCalledWith(component);
  });

  it('passes undefined props for void-prop modals', () => {
    const component = dialog<NoProps>();
    const modal = defineModal<void, void>(component);

    void modal.show();

    expect(niceModal.show).toHaveBeenCalledWith(component, undefined);
  });
});

describe('getErrorMessage', () => {
  it('normalizes error messages from common thrown values', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('plain')).toBe('plain');
    expect(getErrorMessage({ message: 'ignored' })).toBe(
      'An unknown error occurred'
    );
  });
});
