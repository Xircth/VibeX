import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { IDEWorkspaceRoute } from '@/components/layout/IDEWorkspaceRoute';
import { NormalLayout } from '@/components/layout/NormalLayout';
import { ProjectRail } from '@/components/layout/ProjectRail';
import { FullAttemptLogsPage } from '@/pages/FullAttemptLogs';
import { ProjectTasks } from '@/pages/ProjectTasks';
import { Projects } from '@/pages/Projects';
import {
  AgentSettings,
  AppearanceSettings,
  AutomationsSettings,
  ChatChannelSettings,
  DeviceSettings,
  EditorSettings,
  GeneralSettings,
  InstructionsSettings,
  LogsSettings,
  McpSettings,
  PluginsSettings,
  SettingsLayout,
  ShortcutSettings,
  SkillsSettings,
  SystemSettings,
  VersionControlSettings,
  WebServiceSettings,
} from '@/pages/settings/';

function MainLegacyScope({
  children,
  className,
  showProjectRail = false,
}: {
  children: ReactNode;
  className?: string;
  showProjectRail?: boolean;
}) {
  return (
    <LegacyDesignScope className={className}>
      {showProjectRail ? <ProjectRail /> : null}
      {children}
    </LegacyDesignScope>
  );
}

export function MainAppRoutes() {
  return (
    <Routes>
      <Route
        path="/local-projects/:projectId/workspaces/:workspaceId/full"
        element={
          <MainLegacyScope>
            <FullAttemptLogsPage />
          </MainLegacyScope>
        }
      />

      <Route
        element={
          <MainLegacyScope showProjectRail>
            <IDEWorkspaceRoute />
          </MainLegacyScope>
        }
      >
        <Route
          path="/local-projects/:projectId/sessions"
          element={<ProjectTasks />}
        />
        <Route
          path="/local-projects/:projectId/workspaces/:workspaceId"
          element={<ProjectTasks />}
        />
        <Route
          path="/local-projects/:projectId/workspaces/:workspaceId/sessions/:sessionId"
          element={<ProjectTasks />}
        />
      </Route>

      <Route
        path="/settings/*"
        element={
          <MainLegacyScope>
            <SettingsLayout />
          </MainLegacyScope>
        }
      >
        <Route index element={<Navigate to="agents" replace />} />
        <Route path="agents" element={<AgentSettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
        <Route path="general" element={<GeneralSettings />} />
        <Route path="mcp" element={<McpSettings />} />
        <Route path="skills" element={<SkillsSettings />} />
        <Route path="instructions" element={<InstructionsSettings />} />
        <Route path="shortcuts" element={<ShortcutSettings />} />
        <Route path="editor" element={<EditorSettings />} />
        <Route path="version-control" element={<VersionControlSettings />} />
        <Route path="chat-channels" element={<ChatChannelSettings />} />
        <Route path="automations" element={<AutomationsSettings />} />
        <Route path="plugins" element={<PluginsSettings />} />
        <Route path="web-service" element={<WebServiceSettings />} />
        <Route path="devices" element={<DeviceSettings />} />
        <Route path="logs" element={<LogsSettings />} />
        <Route path="system" element={<SystemSettings />} />
      </Route>

      <Route
        element={
          <MainLegacyScope showProjectRail>
            <NormalLayout />
          </MainLegacyScope>
        }
      >
        <Route path="/" element={<Projects />} />
        <Route path="/local-projects" element={<Projects />} />
        <Route path="/local-projects/:projectId" element={<Projects />} />
        <Route
          path="/mcp-servers"
          element={<Navigate to="/settings/mcp" replace />}
        />
        <Route
          path="/workspaces/*"
          element={<Navigate to="/local-projects" replace />}
        />
        <Route
          path="/projects/*"
          element={<Navigate to="/local-projects" replace />}
        />
      </Route>
    </Routes>
  );
}
