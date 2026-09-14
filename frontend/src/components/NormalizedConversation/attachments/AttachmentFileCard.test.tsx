import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttachmentFileCard } from './AttachmentFileCard';

describe('AttachmentFileCard', () => {
  it('shows the filename, size, and modified time', () => {
    render(
      <AttachmentFileCard
        name="notes.pdf"
        sizeBytes={2048}
        modifiedAt="2026-09-13T04:30:00.000Z"
      />
    );

    const card = screen.getByTestId('attachment-file-card');
    expect(card).toHaveAttribute('title', 'notes.pdf');
    expect(card).toHaveTextContent('notes.pdf');
    expect(card).toHaveTextContent('2.0 KB');
  });

  it('truncates visually but keeps the full name for hover', () => {
    const name = 'very-long-design-spec-document-name.pdf';
    render(<AttachmentFileCard name={name} sizeBytes={512} />);

    expect(screen.getByTestId('attachment-file-card')).toHaveAttribute(
      'title',
      name
    );
  });
});
