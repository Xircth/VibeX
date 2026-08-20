import { scheduleIdleWork } from '@/lib/scheduleIdleWork';

export function isSettingsSurfacePath(pathname: string): boolean {
  return pathname.startsWith('/settings') || pathname.startsWith('/plugins');
}

export function loadAgentSettings() {
  return import('@/pages/settings/AgentSettings');
}

export function loadAppearanceSettings() {
  return import('@/pages/settings/AppearanceSettings');
}

export function loadAutomationCenter() {
  return import('@/pages/settings/AutomationCenter');
}

export function loadAutomationEditorRoutes() {
  return import('@/pages/settings/AutomationEditorRoutes');
}

export function loadChatChannelSettings() {
  return import('@/pages/settings/ChatChannelSettings');
}

export function loadEditorSettings() {
  return import('@/pages/settings/EditorSettings');
}

export function loadGeneralSettings() {
  return import('@/pages/settings/GeneralSettings');
}

export function loadInstructionsSettings() {
  return import('@/pages/settings/InstructionsSettings');
}

export function loadLogsSettings() {
  return import('@/pages/settings/LogsSettings');
}

export function loadMcpSettings() {
  return import('@/pages/settings/McpSettings');
}

export function loadShortcutSettings() {
  return import('@/pages/settings/ShortcutSettings');
}

export function loadSkillsSettings() {
  return import('@/pages/settings/SkillsSettings');
}

export function loadSystemSettings() {
  return import('@/pages/settings/SystemSettings');
}

export function loadVersionControlSettings() {
  return import('@/pages/settings/VersionControlSettings');
}

export function loadWorktreeSettings() {
  return import('@/pages/settings/WorktreeSettings');
}

export function loadWebServiceSettings() {
  return import('@/pages/settings/WebServiceSettings');
}

export function loadPluginsPage() {
  return import('@/pages/Plugins');
}

export function loadPluginDetailPage() {
  return import('@/pages/plugins/ProductPlugins');
}

const SETTINGS_PATH_LOADERS: Record<string, () => Promise<unknown>> = {
  '/settings/agents': loadAgentSettings,
  '/settings/appearance': loadAppearanceSettings,
  '/settings/general': loadGeneralSettings,
  '/settings/mcp': loadMcpSettings,
  '/settings/skills': loadSkillsSettings,
  '/settings/instructions': loadInstructionsSettings,
  '/settings/shortcuts': loadShortcutSettings,
  '/settings/editor': loadEditorSettings,
  '/settings/version-control': loadVersionControlSettings,
  '/settings/worktrees': loadWorktreeSettings,
  '/settings/chat-channels': loadChatChannelSettings,
  '/settings/automations': loadAutomationCenter,
  '/settings/web-service': loadWebServiceSettings,
  '/settings/devices': loadWebServiceSettings,
  '/settings/logs': loadLogsSettings,
  '/settings/system': loadSystemSettings,
  '/plugins': loadPluginsPage,
};

export function warmDefaultSettingsSurface(
  pathname = typeof window === 'undefined' ? '' : window.location.pathname
): void {
  if (pathname.startsWith('/plugins')) {
    void loadPluginsPage();
    void loadPluginDetailPage();
    return;
  }
  if (pathname.startsWith('/settings')) {
    void loadAgentSettings();
  }
}

export function preloadRemainingSettingsPages(): void {
  for (const load of new Set([
    ...Object.values(SETTINGS_PATH_LOADERS),
    loadAutomationEditorRoutes,
  ])) {
    void load();
  }
}

export function preloadSettingsPath(path: string): void {
  void SETTINGS_PATH_LOADERS[path]?.();
}

export function scheduleRemainingSettingsPreload(): () => void {
  if (
    typeof window === 'undefined' ||
    !isSettingsSurfacePath(window.location.pathname)
  ) {
    return () => undefined;
  }
  return scheduleIdleWork(() => {
    preloadRemainingSettingsPages();
  });
}
