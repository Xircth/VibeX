export type SettingsSearchEntry = {
  id: string;
  path: string;
  labelKey: string;
  groupKey: string;
  capability?: string;
  anyOf?: string[];
};

const page = (
  groupKey: string,
  path: string,
  options?: { capability?: string; anyOf?: string[] }
) => ({
  groupKey,
  path,
  capability: options?.capability,
  anyOf: options?.anyOf,
});

const PAGES = {
  agents: page('agents', '/settings/agents', {
    capability: 'application.call',
  }),
  appearance: page('appearance', '/settings/appearance'),
  general: page('general', '/settings/general', {
    capability: 'application.call',
  }),
  mcp: page('mcp', '/settings/mcp', { capability: 'application.call' }),
  skills: page('skills', '/settings/skills', {
    capability: 'application.call',
  }),
  instructions: page('instructions', '/settings/instructions', {
    capability: 'application.call',
  }),
  shortcuts: page('shortcuts', '/settings/shortcuts'),
  versionControl: page('versionControl', '/settings/version-control', {
    capability: 'application.call',
  }),
  worktrees: page('worktrees', '/settings/worktrees', {
    capability: 'application.call',
  }),
  chatChannels: page('chatChannels', '/settings/chat-channels', {
    capability: 'application.call',
  }),
  automations: page('automations', '/settings/automations', {
    capability: 'automation.read',
  }),
  plugins: page('plugins', '/plugins', { capability: 'plugin.read' }),
  webService: page('webService', '/settings/web-service', {
    anyOf: ['desktop.tauri', 'device.pair'],
  }),
  logs: page('logs', '/settings/logs', { capability: 'desktop.tauri' }),
  system: page('system', '/settings/system', { capability: 'desktop.tauri' }),
} as const;

function entriesFor(
  pageKey: keyof typeof PAGES,
  labelKeys: string[]
): SettingsSearchEntry[] {
  const meta = PAGES[pageKey];
  return labelKeys.map((labelKey) => ({
    id: labelKey,
    path: meta.path,
    labelKey,
    groupKey: meta.groupKey,
    capability: meta.capability,
    anyOf: meta.anyOf,
  }));
}

export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...Object.entries(PAGES).map(([groupKey, meta]) => ({
    id: `nav.${groupKey}`,
    path: meta.path,
    labelKey: `nav.${groupKey}`,
    groupKey: meta.groupKey,
    capability: meta.capability,
    anyOf: meta.anyOf,
  })),
  ...entriesFor('appearance', [
    'appearance.theme.title',
    'appearance.theme.label',
    'appearance.accent.title',
    'appearance.accent.label',
    'appearance.appIcon.title',
    'appearance.appIcon.label',
    'appearance.zoom.title',
    'appearance.zoom.label',
    'appearance.monoFont.title',
    'appearance.monoFont.label',
    'appearance.language.title',
    'appearance.language.label',
    'appearance.kanbanSessionList.title',
    'appearance.kanbanSessionList.label',
    'appearance.layout.title',
    'appearance.layout.workspaceLabel',
    'appearance.layout.kanbanLabel',
  ]),
  ...entriesFor('general', [
    'general.terminalTitle',
    'general.defaultTerminal',
    'general.externalEditorTitle',
    'general.promptEnhancementTitle',
    'general.enablePromptEnhancement',
    'general.promptEnhancementAgent',
    'general.useCustomPrompt',
    'general.sessionContinuationTitle',
    'general.enablePreviousSessionContinuation',
    'general.importLocalSessionsTitle',
    'general.importLocalSessions',
    'general.notificationsTitle',
    'general.soundNotification',
    'general.pushNotification',
    'general.notifyWhen',
    'general.crashReportsTitle',
    'general.crashReportsToggle',
    'general.previewTitle',
    'general.previewFontSize',
    'general.filesChangedCollapsed',
    'general.linkOpenBehavior',
    'general.aiMessageCollapsed',
    'general.hideModelThinking',
  ]),
  ...entriesFor('agents', [
    'agents.environmentTitle',
    'agents.environmentDiagnosticsTitle',
  ]),
  ...entriesFor('mcp', ['mcp.localTab', 'mcp.marketTab', 'mcp.newMcp']),
  ...entriesFor('skills', ['skills.localTab', 'skills.marketTab']),
  ...entriesFor('instructions', [
    'instructions.title',
    'instructions.newInstruction',
  ]),
  ...entriesFor('shortcuts', [
    'shortcuts.inputTitle',
    'shortcuts.sendLabel',
    'shortcuts.sectionTitle',
    'shortcuts.sequentialTitle',
  ]),
  ...entriesFor('versionControl', [
    'versionControl.title',
    'versionControl.gitVersionSectionTitle',
    'versionControl.currentGitLabel',
    'versionControl.customGitPathLabel',
    'versionControl.worktreeSectionTitle',
    'versionControl.workspaceDirLabel',
    'versionControl.branchPrefixLabel',
    'versionControl.commitReminderSectionTitle',
    'versionControl.enableCommitReminderLabel',
    'versionControl.commitReminderModeLabel',
    'versionControl.commitReminderThresholdLabel',
    'versionControl.prSectionTitle',
    'versionControl.autoPrDescriptionLabel',
    'versionControl.prDescriptionAgent',
    'versionControl.customPrPromptLabel',
    'versionControl.githubAccountSectionTitle',
    'versionControl.loginStatusLabel',
  ]),
  ...entriesFor('worktrees', [
    'worktrees.title',
    'worktrees.projectTitle',
    'worktrees.commandsTitle',
    'worktrees.createCommand',
    'worktrees.deleteCommand',
    'worktrees.cleanupTitle',
    'worktrees.cleanupPrompt',
    'worktrees.cleanupThreshold',
  ]),
  ...entriesFor('chatChannels', ['chatChannels.title']),
  ...entriesFor('automations', [
    'automations.pageTitle',
    'automations.newAutomation',
    'automations.templatesTitle',
  ]),
  ...entriesFor('plugins', ['plugins.pageTitle', 'plugins.developerTools']),
  ...entriesFor('webService', ['webService.title']),
  ...entriesFor('logs', [
    'logs.title',
    'logs.levelTitle',
    'logs.captureLabel',
    'logs.targetsTitle',
    'logs.viewerTitle',
  ]),
  ...entriesFor('system', [
    'appUpdater.title',
    'system.autoCheckUpdate',
    'system.jsonTitle',
    'system.proxyTitle',
    'system.renderingTitle',
    'system.backupTitle',
    'system.clearLocalDataTitle',
  ]),
];
