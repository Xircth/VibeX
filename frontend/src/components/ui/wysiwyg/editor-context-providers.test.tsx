import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  type LocalImageMetadata,
  useLocalImages,
  useTaskAttemptId,
  useTaskId,
} from './context/task-attempt-context';
import { WysiwygEditorContextProviders } from './editor-context-providers';

function ContextProbe() {
  const taskAttemptId = useTaskAttemptId();
  const taskId = useTaskId();
  const localImages = useLocalImages();

  return (
    <div>
      <span data-testid="task-attempt-id">{taskAttemptId}</span>
      <span data-testid="task-id">{taskId}</span>
      <span data-testid="local-image-count">{localImages.length}</span>
      <span data-testid="first-local-image">{localImages[0]?.path}</span>
    </div>
  );
}

describe('WysiwygEditorContextProviders', () => {
  it('provides task and local image context values to children', () => {
    const localImages: LocalImageMetadata[] = [
      {
        path: '.vibe-images/image.png',
        proxy_url: '/api/images/image/file',
        file_name: 'image.png',
        size_bytes: 42,
        format: 'png',
      },
    ];

    render(
      <WysiwygEditorContextProviders
        taskAttemptId="attempt-1"
        taskId="task-1"
        localImages={localImages}
      >
        <ContextProbe />
      </WysiwygEditorContextProviders>
    );

    expect(screen.getByTestId('task-attempt-id')).toHaveTextContent(
      'attempt-1'
    );
    expect(screen.getByTestId('task-id')).toHaveTextContent('task-1');
    expect(screen.getByTestId('local-image-count')).toHaveTextContent('1');
    expect(screen.getByTestId('first-local-image')).toHaveTextContent(
      '.vibe-images/image.png'
    );
  });

  it('keeps the existing empty local image default when omitted', () => {
    render(
      <WysiwygEditorContextProviders>
        <ContextProbe />
      </WysiwygEditorContextProviders>
    );

    expect(screen.getByTestId('local-image-count')).toHaveTextContent('0');
  });
});
