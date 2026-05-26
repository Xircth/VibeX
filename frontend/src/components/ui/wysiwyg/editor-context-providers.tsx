import type { ReactNode } from 'react';

import {
  LocalImagesContext,
  TaskAttemptContext,
  TaskContext,
  type LocalImageMetadata,
} from './context/task-attempt-context';

type WysiwygEditorContextProvidersProps = {
  taskAttemptId?: string;
  taskId?: string;
  localImages?: LocalImageMetadata[];
  children: ReactNode;
};

export function WysiwygEditorContextProviders({
  taskAttemptId,
  taskId,
  localImages,
  children,
}: WysiwygEditorContextProvidersProps) {
  return (
    <TaskAttemptContext.Provider value={taskAttemptId}>
      <TaskContext.Provider value={taskId}>
        <LocalImagesContext.Provider value={localImages ?? []}>
          {children}
        </LocalImagesContext.Provider>
      </TaskContext.Provider>
    </TaskAttemptContext.Provider>
  );
}
