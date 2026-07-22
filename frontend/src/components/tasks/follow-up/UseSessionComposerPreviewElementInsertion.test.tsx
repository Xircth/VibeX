import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  ClickedElementsProvider,
  useClickedElements,
} from '@/contexts/ClickedElementsProvider';
import type { OpenInEditorPayload } from '@/features/browser/inspectTypes';
import {
  getSessionComposerStructuredTokenSegments,
  serializeSessionComposerBackendMessage,
} from './sessionComposerStructuredTokens';
import { useSessionComposerPreviewElementInsertion } from './useSessionComposerPreviewElementInsertion';

const previewPayload: OpenInEditorPayload = {
  selected: {
    editor: 'vscode',
    url: '',
    name: 'SaveButton',
    props: {},
    source: {
      fileName: 'src/App.tsx',
      lineNumber: 12,
      columnNumber: 3,
    },
    pathToSource: 'src/App.tsx:12:3',
  },
  components: [],
  trigger: 'context-menu',
  clickedElement: {
    tag: 'button',
    className: 'primary',
    dataset: {
      preview: '<button class="primary">Save</button>',
    },
  },
};

const secondPreviewPayload: OpenInEditorPayload = {
  ...previewPayload,
  selected: {
    ...previewPayload.selected,
    name: 'HeroTitle',
    source: {
      fileName: 'src/Hero.tsx',
      lineNumber: 20,
      columnNumber: 5,
    },
    pathToSource: 'src/Hero.tsx:20:5',
  },
  clickedElement: {
    tag: 'h1',
    className: 'hero-title',
    dataset: {
      preview: '<h1 class="hero-title">Ship faster</h1>',
    },
  },
};

function wrapper({ children }: { children: ReactNode }) {
  return <ClickedElementsProvider>{children}</ClickedElementsProvider>;
}

describe('useSessionComposerPreviewElementInsertion', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends newly selected preview elements to the composer as structured element tokens', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(
      () => {
        const clickedElements = useClickedElements();
        useSessionComposerPreviewElementInsertion({
          enabled: true,
          getMessage: () => 'Fix',
          onChange,
        });
        return clickedElements;
      },
      { wrapper }
    );

    await act(async () => {
      result.current.addElement(previewPayload);
    });

    const insertedMessage = onChange.mock.lastCall?.[0] as string;
    const tokenSegment = getSessionComposerStructuredTokenSegments(
      insertedMessage
    ).find((segment) => segment.kind === 'token');

    expect(tokenSegment).toMatchObject({
      kind: 'token',
      token: {
        kind: 'element',
        label: 'SaveButton',
      },
    });
    expect(serializeSessionComposerBackendMessage(insertedMessage)).toContain(
      'From preview click:'
    );
    expect(serializeSessionComposerBackendMessage(insertedMessage)).toContain(
      'SaveButton (`src/App.tsx:12:3`)'
    );
  });

  it('appends consecutive preview selections as separate structured tokens', async () => {
    const onChange = vi.fn();
    const { result } = renderHook(
      () => {
        const clickedElements = useClickedElements();
        useSessionComposerPreviewElementInsertion({
          enabled: true,
          getMessage: () => 'Fix',
          onChange,
        });
        return clickedElements;
      },
      { wrapper }
    );

    await act(async () => {
      result.current.addElement(previewPayload);
    });
    await act(async () => {
      result.current.addElement(secondPreviewPayload);
    });

    const insertedMessage = onChange.mock.lastCall?.[0] as string;
    const tokenSegments = getSessionComposerStructuredTokenSegments(
      insertedMessage
    ).filter((segment) => segment.kind === 'token');

    expect(tokenSegments).toHaveLength(2);
    expect(tokenSegments[0]).toMatchObject({
      kind: 'token',
      token: {
        kind: 'element',
        label: 'SaveButton',
      },
    });
    expect(tokenSegments[1]).toMatchObject({
      kind: 'token',
      token: {
        kind: 'element',
        label: 'HeroTitle',
      },
    });
    expect(serializeSessionComposerBackendMessage(insertedMessage)).toContain(
      'HeroTitle (`src/Hero.tsx:20:5`)'
    );
  });

  it('allows reselecting the same preview element after the duplicate-event window', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { result } = renderHook(
      () => {
        const clickedElements = useClickedElements();
        useSessionComposerPreviewElementInsertion({
          enabled: true,
          getMessage: () => 'Fix',
          onChange,
        });
        return clickedElements;
      },
      { wrapper }
    );

    await act(async () => {
      result.current.addElement(previewPayload);
    });

    vi.advanceTimersByTime(80);

    await act(async () => {
      result.current.addElement(previewPayload);
    });

    const insertedMessage = onChange.mock.lastCall?.[0] as string;
    const tokenSegments = getSessionComposerStructuredTokenSegments(
      insertedMessage
    ).filter((segment) => segment.kind === 'token');

    expect(tokenSegments).toHaveLength(2);
    expect(tokenSegments[0]).toMatchObject({
      kind: 'token',
      token: { label: 'SaveButton' },
    });
    expect(tokenSegments[1]).toMatchObject({
      kind: 'token',
      token: { label: 'SaveButton' },
    });
  });
});
