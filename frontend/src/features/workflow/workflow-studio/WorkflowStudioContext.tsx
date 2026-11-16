import { createContext, useContext } from 'react';

import type { WorkflowStudioView } from './useWorkflowStudio';

const WorkflowStudioContext = createContext<WorkflowStudioView | null>(null);

export const WorkflowStudioProvider = WorkflowStudioContext.Provider;

export function useOptionalWorkflowStudioContext(): WorkflowStudioView | null {
  return useContext(WorkflowStudioContext);
}
