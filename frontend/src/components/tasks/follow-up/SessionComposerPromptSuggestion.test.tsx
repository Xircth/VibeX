import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { SessionComposerInput } from './SessionComposerInput';

function renderComposer(
  props: Partial<Parameters<typeof SessionComposerInput>[0]> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionComposerInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onAttachImages={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  );
}

describe('SessionComposerInput promptSuggestion', () => {
  it('displays prompt suggestion placeholder when input is empty and adopts on Tab without submitting', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const onAcceptPromptSuggestion = vi.fn();
    const onDismissPromptSuggestion = vi.fn();

    renderComposer({
      value: '',
      promptSuggestion: '运行测试并检查覆盖率',
      onChange,
      onSubmit,
      onAcceptPromptSuggestion,
      onDismissPromptSuggestion,
    });

    const surface = screen.getByTestId('session-composer-editor');
    const editor = surface.querySelector(
      '[contenteditable="true"]'
    ) as HTMLDivElement;
    expect(editor).not.toBeNull();

    fireEvent.keyDown(editor, { key: 'Tab' });

    expect(onChange).toHaveBeenCalledWith('运行测试并检查覆盖率');
    expect(onAcceptPromptSuggestion).toHaveBeenCalledWith(
      '运行测试并检查覆盖率'
    );
    expect(onDismissPromptSuggestion).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not adopt prompt suggestion on Shift+Tab or when input is non-empty', () => {
    const onChange = vi.fn();
    const onAcceptPromptSuggestion = vi.fn();

    renderComposer({
      value: 'existing draft',
      promptSuggestion: '运行测试并检查覆盖率',
      onChange,
      onAcceptPromptSuggestion,
    });

    const surface = screen.getByTestId('session-composer-editor');
    const editor = surface.querySelector(
      '[contenteditable="true"]'
    ) as HTMLDivElement;

    fireEvent.keyDown(editor, { key: 'Tab' });
    fireEvent.keyDown(editor, { key: 'Tab', shiftKey: true });

    expect(onAcceptPromptSuggestion).not.toHaveBeenCalled();
  });
});
