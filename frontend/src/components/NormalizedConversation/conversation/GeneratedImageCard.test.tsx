import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ImageData } from 'shared/types';
import { GeneratedImageCard } from './GeneratedImageCard';

const show = vi.fn();
vi.mock('@/components/dialogs/wysiwyg/ImagePreviewDialog', () => ({
  ImagePreviewDialog: { show: (...args: unknown[]) => show(...args) },
}));

function image(overrides: Partial<ImageData> = {}): ImageData {
  return { data: 'AAAA', mime_type: 'image/png', uri: null, ...overrides };
}

describe('GeneratedImageCard', () => {
  it('shows a pending placeholder until the image arrives', () => {
    render(<GeneratedImageCard image={null} revisedPrompt={null} />);
    expect(screen.getByText('正在生成图片…')).toBeInTheDocument();
  });

  it('renders the image from base64 data and the revised prompt', () => {
    render(
      <GeneratedImageCard image={image()} revisedPrompt="a red bicycle" />
    );

    const img = screen.getByRole('img', { name: 'a red bicycle' });
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(screen.getByText('修订提示词')).toBeInTheDocument();
    expect(screen.getByText('a red bicycle')).toBeInTheDocument();
  });

  it('prefers a hosted uri when present and exposes a download link', () => {
    render(
      <GeneratedImageCard
        image={image({ uri: 'https://cdn/img.png' })}
        revisedPrompt={null}
      />
    );

    const download = screen.getByTitle('下载图片');
    expect(download).toHaveAttribute('href', 'https://cdn/img.png');
    expect(download).toHaveAttribute('download', 'generated-image.png');
  });

  it('opens the preview dialog with the real image source', () => {
    show.mockClear();
    render(<GeneratedImageCard image={image()} revisedPrompt="x" />);

    fireEvent.click(screen.getByRole('button', { name: '预览生成图片' }));

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: 'data:image/png;base64,AAAA' })
    );
  });
});
