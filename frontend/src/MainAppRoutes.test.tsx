import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { MainAppRoutes } from './MainAppRoutes';

vi.mock('@/components/legacy-design/LegacyDesignScope', () => ({
  LegacyDesignScope: ({ children }: { children: React.ReactNode }) => (
    <section data-testid="legacy-scope">{children}</section>
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

vi.mock('@/components/layout/ProjectRail', () => ({
  ProjectRail: () => <aside data-testid="project-rail" />,
}));

vi.mock('@/pages/settings/SettingsLayout', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const { Outlet } =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );

  return {
    SettingsLayout: () =>
      React.createElement(
        'div',
        { 'data-testid': 'settings-layout' },
        React.createElement(Outlet)
      ),
  };
});

vi.mock('@/pages/settings/AgentSettings', () => ({
  AgentSettings: () => <div data-testid="settings-agents" />,
}));
vi.mock('@/pages/settings/AppearanceSettings', () => ({
  AppearanceSettings: () => <div data-testid="settings-appearance" />,
}));
vi.mock('@/pages/settings/AutomationCenter', () => ({
  AutomationCenter: () => <div data-testid="settings-automations" />,
}));
vi.mock('@/pages/settings/AutomationEditorRoutes', () => ({
  AutomationEditRoute: () => <div data-testid="settings-automation-edit" />,
  TurnAutomationEditorRoute: () => (
    <div data-testid="settings-automation-turn-new" />
  ),
  WorkflowAutomationEditorRoute: () => (
    <div data-testid="settings-automation-workflow-new" />
  ),
}));
vi.mock('@/pages/settings/ChatChannelSettings', () => ({
  ChatChannelSettings: () => <div data-testid="settings-chat-channels" />,
}));
vi.mock('@/pages/settings/DeviceSettings', () => ({
  DeviceSettings: () => <div data-testid="settings-devices" />,
}));
vi.mock('@/pages/settings/EditorSettings', () => ({
  EditorSettings: () => <div data-testid="settings-editor" />,
}));
vi.mock('@/pages/settings/GeneralSettings', () => ({
  GeneralSettings: () => <div data-testid="settings-general" />,
}));
vi.mock('@/pages/settings/InstructionsSettings', () => ({
  InstructionsSettings: () => <div data-testid="settings-instructions" />,
}));
vi.mock('@/pages/settings/LogsSettings', () => ({
  LogsSettings: () => <div data-testid="settings-logs" />,
}));
vi.mock('@/pages/settings/McpSettings', () => ({
  McpSettings: () => <div data-testid="settings-mcp" />,
}));
vi.mock('@/pages/settings/ShortcutSettings', () => ({
  ShortcutSettings: () => <div data-testid="settings-shortcuts" />,
}));
vi.mock('@/pages/settings/SkillsSettings', () => ({
  SkillsSettings: () => <div data-testid="settings-skills" />,
}));
vi.mock('@/pages/settings/SystemSettings', () => ({
  SystemSettings: () => <div data-testid="settings-system" />,
}));
vi.mock('@/pages/settings/VersionControlSettings', () => ({
  VersionControlSettings: () => <div data-testid="settings-version-control" />,
}));
vi.mock('@/pages/settings/WorktreeSettings', () => ({
  WorktreeSettings: () => <div data-testid="settings-worktrees" />,
}));
vi.mock('@/pages/settings/WebServiceSettings', () => ({
  WebServiceSettings: () => <div data-testid="settings-web-service" />,
}));

vi.mock('@/pages/Projects', () => ({
  Projects: () => <div data-testid="projects-page" />,
}));

vi.mock('@/pages/ProjectTasks', () => ({
  ProjectTasks: () => <div data-testid="project-tasks-page" />,
}));

vi.mock('@/pages/FullAttemptLogs', () => ({
  FullAttemptLogsPage: () => <div data-testid="full-attempt-logs-page" />,
}));

vi.mock('@/pages/Plugins', () => ({
  PluginsPage: () => <div data-testid="plugins-page" />,
}));

vi.mock('@/pages/plugins/ProductPlugins', () => ({
  PluginDetailPage: () => <div data-testid="plugin-detail-page" />,
}));

function renderAt(pathname: string) {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <MainAppRoutes />
    </MemoryRouter>
  );
}

describe('MainAppRoutes', () => {
  it.each([
    '/local-projects/project-1',
    '/local-projects/project-1/workspaces/workspace-1/sessions/session-1',
  ])('mounts one shared project rail on %s', (pathname) => {
    renderAt(pathname);

    expect(screen.getAllByTestId('project-rail')).toHaveLength(1);
  });

  it('renders project routes through the standard legacy layout', () => {
    renderAt('/local-projects/project-1');

    expect(screen.getByTestId('normal-layout')).toBeInTheDocument();
    expect(screen.getByTestId('projects-page')).toBeInTheDocument();
  });

  it('renders workspace session routes through the IDE layout', async () => {
    renderAt(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1'
    );

    expect(await screen.findByTestId('ide-layout')).toBeInTheDocument();
    expect(screen.getByTestId('project-tasks-page')).toBeInTheDocument();
  });

  it('keeps full attempt logs outside the standard and IDE layout groups', async () => {
    renderAt('/local-projects/project-1/workspaces/workspace-1/full');

    expect(
      await screen.findByTestId('full-attempt-logs-page')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('normal-layout')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ide-layout')).not.toBeInTheDocument();
  });

  it('redirects settings index to agent settings', async () => {
    renderAt('/settings');

    expect(await screen.findByTestId('settings-agents')).toBeInTheDocument();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('project-rail')).not.toBeInTheDocument();
  });

  it('keeps the product plugin module inside the settings layout', async () => {
    renderAt('/plugins');

    expect(await screen.findByTestId('plugins-page')).toBeInTheDocument();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('project-rail')).not.toBeInTheDocument();
  });

  it('keeps the settings layout around an independent plugin detail page', async () => {
    renderAt('/plugins/vibex.office');

    expect(await screen.findByTestId('plugin-detail-page')).toBeInTheDocument();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('project-rail')).not.toBeInTheDocument();
  });

  it('redirects the legacy settings plugin path to the product module', async () => {
    renderAt('/settings/plugins');

    expect(await screen.findByTestId('plugins-page')).toBeInTheDocument();
    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
  });

  it('does not expose the removed model providers settings route', () => {
    renderAt('/settings/model-providers');

    expect(screen.getByTestId('settings-layout')).toBeInTheDocument();
    expect(
      screen.queryByTestId(/^settings-model-providers$/)
    ).not.toBeInTheDocument();
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
