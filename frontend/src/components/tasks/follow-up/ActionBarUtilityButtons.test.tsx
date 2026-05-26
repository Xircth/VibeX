import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionBarUtilityButtons } from './ActionBarUtilityButtons';

function renderUtilityButtons(
  props: Partial<Parameters<typeof ActionBarUtilityButtons>[0]> = {}
) {
  return render(
    <ActionBarUtilityButtons
      canCompactContext={true}
      isCompactingContext={false}
      promptEnhancementEnabled={true}
      isEnhancingPrompt={false}
      canEnhancePrompt={true}
      onCompactContext={vi.fn()}
      onEnhancePrompt={vi.fn()}
      {...props}
    />
  );
}

describe('ActionBarUtilityButtons', () => {
  it('renders a correctly labeled compact button and calls the compact action', () => {
    const onCompactContext = vi.fn();
    renderUtilityButtons({ onCompactContext });

    fireEvent.click(screen.getByRole('button', { name: '压缩上下文' }));

    expect(screen.getByTitle('压缩上下文')).toBeInTheDocument();
    expect(onCompactContext).toHaveBeenCalledTimes(1);
  });

  it('disables compact when unavailable and shows compact loading state', () => {
    const onCompactContext = vi.fn();
    renderUtilityButtons({
      canCompactContext: false,
      isCompactingContext: true,
      onCompactContext,
    });

    const button = screen.getByRole('button', { name: '压缩上下文' });
    expect(button).toBeDisabled();
    expect(button.querySelector('.animate-spin')).toBeInTheDocument();

    fireEvent.click(button);
    expect(onCompactContext).not.toHaveBeenCalled();
  });

  it('omits prompt enhancement when disabled', () => {
    renderUtilityButtons({ promptEnhancementEnabled: false });

    expect(
      screen.queryByRole('button', { name: '提示词优化' })
    ).not.toBeInTheDocument();
  });

  it('gates prompt enhancement availability and loading', () => {
    const onEnhancePrompt = vi.fn();
    const { rerender } = renderUtilityButtons({
      canEnhancePrompt: false,
      onEnhancePrompt,
    });

    const disabledButton = screen.getByRole('button', {
      name: '提示词优化',
    });
    expect(disabledButton).toBeDisabled();
    fireEvent.click(disabledButton);
    expect(onEnhancePrompt).not.toHaveBeenCalled();

    rerender(
      <ActionBarUtilityButtons
        canCompactContext={true}
        isCompactingContext={false}
        promptEnhancementEnabled={true}
        isEnhancingPrompt={true}
        canEnhancePrompt={true}
        onCompactContext={vi.fn()}
        onEnhancePrompt={onEnhancePrompt}
      />
    );

    expect(
      screen.getByRole('button', { name: '提示词优化' }).querySelector(
        '.animate-spin'
      )
    ).toBeInTheDocument();
  });

  it('calls prompt enhancement when available', () => {
    const onEnhancePrompt = vi.fn();
    renderUtilityButtons({ onEnhancePrompt });

    fireEvent.click(screen.getByRole('button', { name: '提示词优化' }));

    expect(onEnhancePrompt).toHaveBeenCalledTimes(1);
  });
});
