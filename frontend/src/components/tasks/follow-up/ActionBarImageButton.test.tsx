import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionBarImageButton } from './ActionBarImageButton';

const ATTACH_FILES_LABEL = '\u9644\u52a0\u6587\u4ef6';

function renderImageButton({
  isEditable = true,
  onAttachImages = vi.fn(),
}: {
  isEditable?: boolean;
  onAttachImages?: (files: File[]) => void;
} = {}) {
  const view = render(
    <ActionBarImageButton
      isEditable={isEditable}
      onAttachImages={onAttachImages}
    />
  );
  const input = view.container.querySelector(
    'input[type="file"]'
  ) as HTMLInputElement;
  return { ...view, input, onAttachImages };
}

describe('ActionBarImageButton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the hidden file input from the paperclip button', () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderImageButton();

    fireEvent.click(screen.getByRole('button', { name: ATTACH_FILES_LABEL }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('does not open the file input when disabled', () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderImageButton({ isEditable: false });

    fireEvent.click(screen.getByRole('button', { name: ATTACH_FILES_LABEL }));

    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('accepts documents, images, and videos and resets the input value', () => {
    const onAttachImages = vi.fn();
    const { input } = renderImageButton({ onAttachImages });
    const image = new File(['image'], 'image.png', { type: 'image/png' });
    const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
    const text = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'value', {
      value: 'C:\\fakepath\\image.png',
      writable: true,
      configurable: true,
    });

    fireEvent.change(input, {
      target: {
        files: [image, video, text, pdf],
      },
    });

    expect(onAttachImages).toHaveBeenCalledWith([image, video, text, pdf]);
    expect(input.value).toBe('');
  });

  it('resets the input without dispatching when no files are selected', () => {
    const onAttachImages = vi.fn();
    const { input } = renderImageButton({ onAttachImages });
    Object.defineProperty(input, 'value', {
      value: 'C:\\fakepath\\notes.txt',
      writable: true,
      configurable: true,
    });

    fireEvent.change(input, {
      target: {
        files: [],
      },
    });

    expect(onAttachImages).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });
});
