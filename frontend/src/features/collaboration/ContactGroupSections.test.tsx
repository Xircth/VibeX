import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTACT_GROUP_RENAME_BLUR_GRACE_MS,
  ContactGroupNameInput,
  ContactGroupSections,
} from './ContactGroupSections';

const section = {
  id: 'g1',
  name: '核心',
  ungrouped: false,
  entries: [{ key: 'a' }],
};

describe('ContactGroupSections rename chrome', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the chevron beside the rename field', () => {
    render(
      <ContactGroupSections
        sections={[section]}
        collapsed={new Set()}
        renamingId="g1"
        renamePlaceholder="分组名称"
        toggleLabel={(name) => name}
        onToggle={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        onHeaderContextMenu={vi.fn()}
        onDropContact={vi.fn()}
        renderEntry={(entry) => <div key={entry.key}>row</div>}
      />
    );
    const header = screen.getByTestId(
      'collaboration-contact-section-header-g1'
    );
    const chevron = header.querySelector(
      '.collaboration-contact-section-chevron'
    );
    const input = screen.getByTestId(
      'collaboration-contact-group-rename-input'
    );
    expect(chevron).not.toBeNull();
    expect(header.contains(input)).toBe(true);
    expect(
      chevron!.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('ignores the first blur while a menu is still restoring focus', () => {
    vi.useFakeTimers();
    const onCancel = vi.fn();
    render(
      <ContactGroupNameInput
        initialValue="新分组"
        placeholder="分组名称"
        onSubmit={vi.fn()}
        onCancel={onCancel}
        testId="collaboration-contact-group-rename-input"
      />
    );
    const input = screen.getByTestId(
      'collaboration-contact-group-rename-input'
    );
    fireEvent.blur(input);
    expect(onCancel).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(CONTACT_GROUP_RENAME_BLUR_GRACE_MS - 1);
    });
    fireEvent.blur(input);
    expect(onCancel).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.blur(input);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
