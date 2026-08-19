import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { NormalLayout } from '@/components/layout/NormalLayout';
import { ProjectRail } from '@/components/layout/ProjectRail';
import { Loader } from '@/components/ui/loader';
import { Projects } from '@/pages/Projects';

function lazyNamed<
  T extends Record<Name, ComponentType>,
  Name extends keyof T & string,
>(load: () => Promise<T>, name: Name) {
  return lazy(() => load().then((mod) => ({ default: mod[name] })));
}

const IDEWorkspaceRoute = lazyNamed(
  () => import('@/components/layout/IDEWorkspaceRoute'),
  'IDEWorkspaceRoute'
);
const ProjectTasks = lazyNamed(
  () => import('@/pages/ProjectTasks'),
  'ProjectTasks'
);
const FullAttemptLogsPage = lazyNamed(
  () => import('@/pages/FullAttemptLogs'),
  'FullAttemptLogsPage'
);
const PluginsPage = lazyNamed(() => import('@/pages/Plugins'), 'PluginsPage');
const PluginDetailPage = lazyNamed(
  () => import('@/pages/plugins/ProductPlugins'),
  'PluginDetailPage'
);
const WorkflowInspector = lazyNamed(
  () => import('@/pages/workflows/WorkflowInspector'),
  'WorkflowInspector'
);
const SettingsLayout = lazyNamed(
  () => import('@/pages/settings/SettingsLayout'),
  'SettingsLayout'
);
const AgentSettings = lazyNamed(
  () => import('@/pages/settings/AgentSettings'),
  'AgentSettings'
);
const AppearanceSettings = lazyNamed(
  () => import('@/pages/settings/AppearanceSettings'),
  'AppearanceSettings'
);
const AutomationsSettings = lazyNamed(
  () => import('@/pages/settings/AutomationsSettings'),
  'AutomationsSettings'
);
const ChatChannelSettings = lazyNamed(
  () => import('@/pages/settings/ChatChannelSettings'),
  'ChatChannelSettings'
);
const DeviceSettings = lazyNamed(
  () => import('@/pages/settings/DeviceSettings'),
  'DeviceSettings'
);
const EditorSettings = lazyNamed(
  () => import('@/pages/settings/EditorSettings'),
  'EditorSettings'
);
const GeneralSettings = lazyNamed(
  () => import('@/pages/settings/GeneralSettings'),
  'GeneralSettings'
);
const InstructionsSettings = lazyNamed(
  () => import('@/pages/settings/InstructionsSettings'),
  'InstructionsSettings'
);
const LogsSettings = lazyNamed(
  () => import('@/pages/settings/LogsSettings'),
  'LogsSettings'
);
const McpSettings = lazyNamed(
  () => import('@/pages/settings/McpSettings'),
  'McpSettings'
);
const ShortcutSettings = lazyNamed(
  () => import('@/pages/settings/ShortcutSettings'),
  'ShortcutSettings'
);
const SkillsSettings = lazyNamed(
  () => import('@/pages/settings/SkillsSettings'),
  'SkillsSettings'
);
const SystemSettings = lazyNamed(
  () => import('@/pages/settings/SystemSettings'),
  'SystemSettings'
);
const VersionControlSettings = lazyNamed(
  () => import('@/pages/settings/VersionControlSettings'),
  'VersionControlSettings'
);
const WorktreeSettings = lazyNamed(
  () => import('@/pages/settings/WorktreeSettings'),
  'WorktreeSettings'
);
const WebServiceSettings = lazyNamed(
  () => import('@/pages/settings/WebServiceSettings'),
  'WebServiceSettings'
);

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
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </LegacyDesignScope>
  );
}

function RouteFallback() {
  return <Loader size={24} className="h-full min-h-[40vh]" />;
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
        element={
          <MainLegacyScope>
            <SettingsLayout />
          </MainLegacyScope>
        }
      >
        <Route path="/settings/*">
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
          <Route path="worktrees" element={<WorktreeSettings />} />
          <Route path="chat-channels" element={<ChatChannelSettings />} />
          <Route path="automations" element={<AutomationsSettings />} />
          <Route path="plugins" element={<Navigate to="/plugins" replace />} />
          <Route path="web-service" element={<WebServiceSettings />} />
          <Route path="devices" element={<DeviceSettings />} />
          <Route path="logs" element={<LogsSettings />} />
          <Route path="system" element={<SystemSettings />} />
        </Route>
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/plugins/:pluginId" element={<PluginDetailPage />} />
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
        <Route path="/workflows/:runId" element={<WorkflowInspector />} />
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
