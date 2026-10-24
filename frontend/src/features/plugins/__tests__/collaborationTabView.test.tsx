import { render, screen } from '@testing-library/react';
import { viewRegistry } from '@vibex/plugin-sdk';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COLLABORATION_WORKSPACE_TAB } from '@/lib/hostSurfaceIds';
import { bootstrapCoreFoundationPlugins } from '../coreFoundationPlugins';
import { unloadAllPluginRuntimes } from '../PluginRuntimeLoader';

vi.mock('@/features/collaboration/CollaborationSpacePage', () => ({
  CollaborationSpacePage: () => <div data-testid="collaboration-workspace" />,
}));

describe('collaboration tab view', () => {
  beforeEach(() => {
    unloadAllPluginRuntimes();
    viewRegistry.clear();
  });

  it('is owned by vibex.core.delegation, uses the built-in tab id and i18n title, and renders CollaborationSpacePage', async () => {
    await bootstrapCoreFoundationPlugins();
    const view = viewRegistry.get(COLLABORATION_WORKSPACE_TAB);
    expect(view?.pluginId).toBe('vibex.core.delegation');
    expect(view?.title).not.toBe('Collaboration Space');
    expect(['协作空间', 'Collaboration']).toContain(view?.title);
    const Component = view?.component as ComponentType<{
      projectId?: string | null;
    }>;
    render(<Component projectId="p1" />);
    expect(
      await screen.findByTestId('collaboration-workspace')
    ).toBeInTheDocument();
  });
});
