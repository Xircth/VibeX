import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { SessionComposerInput } from './SessionComposerInput';

function renderComposerInput(
  props: Partial<Parameters<typeof SessionComposerInput>[0]> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SessionComposerInput
        value=""
        images={[]}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onAttachImages={vi.fn()}
        onRemoveImage={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  );
}

describe('SessionComposerInput', () => {
  it('reports textarea changes', () => {
    const onChange = vi.fn();
    renderComposerInput({ onChange });

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'ship this' },
    });

    expect(onChange).toHaveBeenCalledWith('ship this');
  });

  it('submits on Enter when Enter is the send shortcut', () => {
    const onSubmit = vi.fn();
    renderComposerInput({ context: { sendShortcut: 'Enter' }, onSubmit });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submits on Ctrl+Enter when ModifierEnter is the send shortcut', () => {
    const onSubmit = vi.fn();
    renderComposerInput({
      context: { sendShortcut: 'ModifierEnter' },
      onSubmit,
    });

    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      ctrlKey: true,
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit on plain Enter when ModifierEnter is the send shortcut', () => {
    const onSubmit = vi.fn();
    renderComposerInput({
      context: { sendShortcut: 'ModifierEnter' },
      onSubmit,
    });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit when disabled', () => {
    const onSubmit = vi.fn();
    renderComposerInput({ disabled: true, onSubmit });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
