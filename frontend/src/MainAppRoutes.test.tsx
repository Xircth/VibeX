import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { MainAppRoutes } from './MainAppRoutes';

vi.mock('@/components/legacy-design/LegacyDesignScope', () => ({
  LegacyDesignScope: ({ children }: { children: React.ReactNode }) => (
    <section data-testid="legacy-scope">{children}</section>
  ),
}));

vi.mock('@/components/layout/ProjectWindowManager', () => ({
  ProjectRailProjectDialogBridge: () => (
    <div data-testid="project-dialog-bridge" />
  ),
}));

vi.mock('@/components/layout/NormalLayout', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const { Outlet } =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );

  return {
    NormalLayout: () =>
      React.createElement(
        'div',
        { 'data-testid': 'normal-layout' },
        React.createElement(Outlet)
      ),
  };
});

vi.mock('@/components/layout/IDEWorkspaceRoute', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const { Outlet } =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );

  return {
    IDEWorkspaceRoute: () =>
      React.createElement(
        'div',
        { 'data-testid': 'ide-layout' },
        React.createElement(Outlet)
      ),
  };
});

vi.mock('@/pages/settings/', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const { Outlet } =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );

  return {
    AgentSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-agents' }),
    AppearanceSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-appearance' }),
    ChatChannelSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-chat-channels' }),
    EditorSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-editor' }),
    GeneralSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-general' }),
    InstructionsSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-instructions' }),
    McpSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-mcp' }),
    ModelProviderSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-model-providers' }),
    SettingsLayout: () =>
      React.createElement(
        'div',
        { 'data-testid': 'settings-layout' },
        React.createElement(Outlet)
      ),
    ShortcutSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-shortcuts' }),
    SkillsSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-skills' }),
    SystemSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-system' }),
    VersionControlSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-version-control' }),
    WebServiceSettings: () =>
      React.createElement('div', { 'data-testid': 'settings-web-service' }),
  };
});

vi.mock('@/pages/Projects', () => ({
  Projects: () => <div data-testid="projects-page" />,
}));

vi.mock('@/pages/ProjectTasks', () => ({
  ProjectTasks: () => <div data-testid="project-tasks-page" />,
}));

vi.mock('@/pages/FullAttemptLogs', () => ({
  FullAttemptLogsPage: () => <div data-testid="full-attempt-logs-page" />,
}));

function renderAt(pathname: string) {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <MainAppRoutes />
    </MemoryRouter>
  );
}

describe('MainAppRoutes', () => {
  it('renders project routes through the standard legacy layout', () => {
    renderAt('/local-projects/project-1');

    expect(screen.getByTestId('normal-layout')).toBeInTheDocument();
    expect(screen.getByTestId('projects-page')).toBeInTheDocument();
    expect(screen.getByTestId('project-dialog-bridge')).toBeInTheDocument();
  });

  it('renders workspace session routes through the IDE layout', () => {
    renderAt(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1'
    );

    expect(screen.getByTestId('ide-layout')).toBeInTheDocument();
    expect(screen.getByTestId('project-tasks-page')).toBeInTheDocument();
  });

  it('keeps full attempt logs outside the standard and IDE layout groups', () => {
    renderAt('/local-projects/project-1/workspaces/workspace-1/full');

    expect(screen.getByTestId('full-attempt-logs-page')).toBeInTheDocument();
    expect(screen.queryByTestId('normal-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ide-layout')).not.toBeInTheDocument();
  });

  it('redirects settings index to agent settings', async () => {
    renderAt('/settings');

    expect(await screen.findByTestId('settings-agents')).toBeInTheDocument();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it('redirects legacy MCP settings path to the settings MCP route', async () => {
    renderAt('/mcp-servers');

    expect(await screen.findByTestId('settings-mcp')).toBeInTheDocument();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it('redirects disabled new UI route families to local projects', async () => {
    renderAt('/workspaces/workspace-1');

    expect(await screen.findByTestId('projects-page')).toBeInTheDocument();
    expect(screen.getByTestId('normal-layout')).toBeInTheDocument();
  });
});
