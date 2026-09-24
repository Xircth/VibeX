import { render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useLayoutStore } from '@/stores/useLayoutStore';

vi.mock('@/features/host-browser/HostBrowserPanel', () => ({
  HostBrowserPanel: ({ panelVisible }: { panelVisible: boolean }) => (
    <div data-testid="host-browser" data-visible={String(panelVisible)} />
  ),
}));

vi.mock('@/hooks/usePluginHostContributions', () => ({
  usePluginHostContributions: () => [],
  contributionMetadata: () => ({}),
}));

vi.mock('@/components/plugins/PluginRemoteView', () => ({
  PluginRemoteView: () => <div data-testid="plugin-remote" />,
}));

import PluginDockviewPanel from './PluginDockviewPanel';

function panelProps(isVisible = true): IDockviewPanelProps {
  return {
    api: {
      id: 'plugin:vibex.browser/browser:1',
      isVisible,
      onDidVisibilityChange: () => ({ dispose() {} }),
    },
    params: { pluginId: 'vibex.browser', contributionId: 'browser' },
  } as unknown as IDockviewPanelProps;
}

function mount(path: string, props: IDockviewPanelProps = panelProps()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/projects/:projectId/workspaces/:workspaceId"
          element={<PluginDockviewPanel {...props} />}
        />
        <Route
          path="/projects/:projectId/sessions"
          element={<PluginDockviewPanel {...props} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('PluginDockviewPanel', () => {
  beforeEach(() => {
    useLayoutStore.setState({ activeTab: 'workspace' });
  });

  it('keeps the native browser visible on the workspace route', () => {
    mount('/projects/p1/workspaces/ws-1');
    expect(screen.getByTestId('host-browser')).toHaveAttribute(
      'data-visible',
      'true'
    );
  });

  it('hides the native browser when the kanban page is active', () => {
    useLayoutStore.setState({ activeTab: 'kanban' });
    mount('/projects/p1/sessions');
    expect(screen.getByTestId('host-browser')).toHaveAttribute(
      'data-visible',
      'false'
    );
  });
});
