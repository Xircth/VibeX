import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CollaborationGlobalSearchModal } from './CollaborationGlobalSearchModal';

describe('CollaborationGlobalSearchModal field chrome', () => {
  it('puts the search icon inside the input and has no divider', () => {
    render(
      <CollaborationGlobalSearchModal
        query=""
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        empty
      >
        {null}
      </CollaborationGlobalSearchModal>
    );
    const modal = screen.getByTestId('collaboration-global-search-modal');
    const input = screen.getByTestId('collaboration-global-search-input');
    const icon = modal.querySelector('.collaboration-global-search-icon');
    const field = modal.querySelector('.collaboration-global-search-field');
    expect(field).not.toBeNull();
    expect(icon).not.toBeNull();
    expect(field!.contains(icon!)).toBe(true);
    expect(field!.contains(input)).toBe(true);
    expect(
      modal.querySelector('.collaboration-global-search-divider')
    ).toBeNull();
  });
});
