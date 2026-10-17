import { describe, expect, it } from 'vitest';

import { kanbanBindsExecutionConversation } from './kanbanViews';
import {
  executionConversationSurface,
  isWorkspaceSurfaceActive,
} from './workspaceSurface';

describe('isWorkspaceSurfaceActive', () => {
  it('treats a workspace or session route as the workspace surface', () => {
    expect(isWorkspaceSurfaceActive('ws-1', undefined, 'kanban')).toBe(true);
    expect(isWorkspaceSurfaceActive(undefined, 'session-1', 'kanban')).toBe(
      true
    );
  });

  it('follows the toolbar tab when the route is not a workspace', () => {
    expect(isWorkspaceSurfaceActive(undefined, undefined, 'workspace')).toBe(
      true
    );
    expect(isWorkspaceSurfaceActive(undefined, undefined, 'kanban')).toBe(
      false
    );
    expect(
      isWorkspaceSurfaceActive(undefined, undefined, 'plugin:acme/tab')
    ).toBe(false);
  });
});

describe('executionConversationSurface', () => {
  it('keeps the workspace execution conversation bound before a workspace is routed', () => {
    expect(
      executionConversationSurface(undefined, undefined, 'workspace')
    ).toBe('workspace');
    expect(
      kanbanBindsExecutionConversation(
        'builtin:canvas',
        executionConversationSurface(undefined, undefined, 'workspace')
      )
    ).toBe(true);
  });

  it('unbinds the hidden kanban execution slot on canvas', () => {
    expect(executionConversationSurface(undefined, undefined, 'kanban')).toBe(
      'kanban'
    );
    expect(
      kanbanBindsExecutionConversation(
        'builtin:canvas',
        executionConversationSurface(undefined, undefined, 'kanban')
      )
    ).toBe(false);
  });
});
