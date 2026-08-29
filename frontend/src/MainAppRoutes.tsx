import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { NormalLayout } from '@/components/layout/NormalLayout';
import { ProjectRail } from '@/components/layout/ProjectRail';
import { Loader } from '@/components/ui/loader';
import {
  loadAgentSettings,
  loadAppearanceSettings,
  loadAutomationCenter,
  loadAutomationEditorRoutes,
  loadChatChannelSettings,
  loadEditorSettings,
  loadGeneralSettings,
  loadInstructionsSettings,
  loadLogsSettings,
  loadMcpSettings,
  loadPluginDetailPage,
  loadPluginsPage,
  loadShortcutSettings,
  loadSkillsSettings,
  loadSystemSettings,
  loadVersionControlSettings,
  loadWebServiceSettings,
  loadWorktreeSettings,
} from '@/lib/settingsPreload';
import { Projects } from '@/pages/Projects';
import { SettingsLayout } from '@/pages/settings/SettingsLayout';

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
const PluginsPage = lazyNamed(loadPluginsPage, 'PluginsPage');
const PluginDetailPage = lazyNamed(loadPluginDetailPage, 'PluginDetailPage');
const MarketplacePluginDetailPage = lazyNamed(
  loadPluginDetailPage,
  'MarketplacePluginDetailPage'
);
const WorkflowInspector = lazyNamed(
  () => import('@/pages/workflows/WorkflowInspector'),
  'WorkflowInspector'
);
const AgentSettings = lazyNamed(loadAgentSettings, 'AgentSettings');
const AppearanceSettings = lazyNamed(
  loadAppearanceSettings,
  'AppearanceSettings'
);
const AutomationCenter = lazyNamed(loadAutomationCenter, 'AutomationCenter');
const AutomationEditRoute = lazyNamed(
  loadAutomationEditorRoutes,
  'AutomationEditRoute'
);
const TurnAutomationEditorRoute = lazyNamed(
  loadAutomationEditorRoutes,
  'TurnAutomationEditorRoute'
);
const WorkflowAutomationEditorRoute = lazyNamed(
  loadAutomationEditorRoutes,
  'WorkflowAutomationEditorRoute'
);
const ChatChannelSettings = lazyNamed(
  loadChatChannelSettings,
  'ChatChannelSettings'
);
const EditorSettings = lazyNamed(loadEditorSettings, 'EditorSettings');
const GeneralSettings = lazyNamed(loadGeneralSettings, 'GeneralSettings');
const InstructionsSettings = lazyNamed(
  loadInstructionsSettings,
  'InstructionsSettings'
);
const LogsSettings = lazyNamed(loadLogsSettings, 'LogsSettings');
const McpSettings = lazyNamed(loadMcpSettings, 'McpSettings');
const ShortcutSettings = lazyNamed(loadShortcutSettings, 'ShortcutSettings');
const SkillsSettings = lazyNamed(loadSkillsSettings, 'SkillsSettings');
const SystemSettings = lazyNamed(loadSystemSettings, 'SystemSettings');
const VersionControlSettings = lazyNamed(
  loadVersionControlSettings,
  'VersionControlSettings'
);
const WorktreeSettings = lazyNamed(loadWorktreeSettings, 'WorktreeSettings');
const WebServiceSettings = lazyNamed(
  loadWebServiceSettings,
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
          <Route path="automations" element={<AutomationCenter />} />
          <Route
            path="automations/new"
            element={<Navigate to="/settings/automations" replace />}
          />
          <Route
            path="automations/new/turn"
            element={<TurnAutomationEditorRoute />}
          />
          <Route
            path="automations/new/workflow"
            element={<WorkflowAutomationEditorRoute />}
          />
          <Route
            path="automations/:automationId/edit"
            element={<AutomationEditRoute />}
          />
          <Route path="plugins" element={<Navigate to="/plugins" replace />} />
          <Route path="web-service" element={<WebServiceSettings />} />
          <Route
            path="devices"
            element={<Navigate to="/settings/web-service" replace />}
          />
          <Route path="logs" element={<LogsSettings />} />
          <Route path="system" element={<SystemSettings />} />
        </Route>
        <Route path="/plugins" element={<PluginsPage />} />
        <Route
          path="/plugins/marketplace/:owner/:pluginName"
          element={<MarketplacePluginDetailPage />}
        />
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
