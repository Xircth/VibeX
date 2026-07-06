export const meta = {
  name: 'i18n-convert',
  description: 'Convert a batch of files to react-i18next under a target namespace, returning key subtrees',
  phases: [{ title: 'Convert' }],
}

// Edit NAMESPACE + ITEMS per wave, then re-invoke with this scriptPath.
const REPO = '/Users/sean/Documents/Projetcs/VibeX'
const namespace = 'tasks'
const items = [
  { file: 'frontend/src/components/kanban/KanbanSessionConversationView.tsx', key: 'sessionConversationView' },
  { file: 'frontend/src/components/kanban/KanbanSessionHub.tsx', key: 'sessionHub' },
  { file: 'frontend/src/components/kanban/KanbanUsageDashboard.tsx', key: 'usageDashboard' },
  { file: 'frontend/src/components/kanban/session-hub/SessionHubListItem.tsx', key: 'hubListItem' },
  { file: 'frontend/src/components/kanban/session-hub/SessionHubMonitor.tsx', key: 'hubMonitor' },
  { file: 'frontend/src/components/kanban/session-hub/SessionHubSidebar.tsx', key: 'hubSidebar' },
  { file: 'frontend/src/components/kanban/session-hub/utils.ts', key: 'hubUtils' },
  { file: 'frontend/src/components/sessions/SessionCreationForm.tsx', key: 'sessionCreation' },
  { file: 'frontend/src/components/sessions/WorkspaceSelector.tsx', key: 'workspaceSelector' },
  { file: 'frontend/src/components/tasks/AgentSelector.tsx', key: 'agentSelector' },
  { file: 'frontend/src/components/tasks/BranchSelector.tsx', key: 'branchSelector' },
  { file: 'frontend/src/components/tasks/CodexModelSelector.tsx', key: 'codexModelSelector' },
  { file: 'frontend/src/components/tasks/ConfigSelector.tsx', key: 'configSelector' },
  { file: 'frontend/src/components/tasks/PermissionSelector.tsx', key: 'permissionSelector' },
  { file: 'frontend/src/components/tasks/PluginSelector.tsx', key: 'pluginSelector' },
  { file: 'frontend/src/components/tasks/ReasoningEffortSelector.tsx', key: 'reasoningEffortSelector' },
  { file: 'frontend/src/components/tasks/RepoBranchSelector.tsx', key: 'repoBranchSelector' },
  { file: 'frontend/src/components/tasks/RepoSelector.tsx', key: 'repoSelector' },
  { file: 'frontend/src/components/tasks/TaskDetails/ProcessesTab.tsx', key: 'processesTab' },
  { file: 'frontend/src/components/tasks/TaskDetails/preview/DevServerLogsView.tsx', key: 'devServerLogs' },
  { file: 'frontend/src/components/tasks/TaskDetails/preview/NoServerContent.tsx', key: 'noServerContent' },
  { file: 'frontend/src/components/tasks/TaskDetails/preview/PreviewToolbar.tsx', key: 'previewToolbar' },
  { file: 'frontend/src/components/tasks/TaskDetails/preview/ReadyContent.tsx', key: 'readyContent' },
  { file: 'frontend/src/components/tasks/TodoPanel.tsx', key: 'todoPanel' },
  { file: 'frontend/src/components/tasks/Toolbar/GitOperations.tsx', key: 'gitOperations' },
  { file: 'frontend/src/components/tasks/follow-up/DiffStatsBar.tsx', key: 'diffStatsBar' },
  { file: 'frontend/src/components/tasks/follow-up/MessageQueueIndicator.tsx', key: 'messageQueue' },
  { file: 'frontend/src/components/tasks/follow-up/SessionModeSelector.tsx', key: 'sessionModeSelector' },
  { file: 'frontend/src/components/tasks/follow-up/TodoListButton.tsx', key: 'todoListButton' },
  { file: 'frontend/src/components/tasks/follow-up/sessionComposerCompact.ts', key: 'composerCompact' },
]

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['file', 'target_key', 'keys_used', 'zh', 'en'],
  properties: {
    file: { type: 'string' },
    target_key: { type: 'string' },
    keys_used: { type: 'array', items: { type: 'string' } },
    zh: { type: 'object', additionalProperties: true },
    en: { type: 'object', additionalProperties: true },
  },
}

phase('Convert')

const results = await parallel(items.map((it) => () =>
  agent(
    `In ${REPO}, fully convert ${it.file} to react-i18next.

RULES:
- Add \`import { useTranslation } from 'react-i18next';\` and inside the component \`const { t } = useTranslation(['${namespace}', 'common']);\` (add alongside existing hooks; if there are multiple components in the file, add to each that renders user-visible text, or hoist a shared t via props — prefer per-component useTranslation).
- Replace EVERY user-visible Chinese (CJK) string literal — titles, descriptions, labels, placeholders, button text, toast messages (toast.success/error/warning/loading/message/custom), aria-labels, tooltip text, empty/loading states, confirm dialogs, option labels — with a t() call under key path \`${it.key}.<descriptiveKey>\`, e.g. \`t('${it.key}.title')\`.
- Reuse shared verbs via common: \`t('common:save')\` / \`t('common:cancel')\` / \`t('common:delete')\` / \`t('common:close')\` / \`t('common:reset')\` / \`t('common:create')\` / \`t('common:run')\` / \`t('common:history')\` / \`t('common:discard')\`. Do NOT re-add those under ${it.key}.
- Interpolation for runtime values: \`t('${it.key}.saveFailed', { error: String(error) })\` with JSON \`"保存失败：{{error}}"\`. Preserve ALL {{placeholders}} identically in zh and en. For pluralized counts keep it simple ({{count}}).
- Do NOT convert: non-CJK technical strings, enum/id values, URLs, code samples, or CJK that lives ONLY inside a different imported component (convert only THIS file's own literals). If this file renders a child component that itself contains CJK, leave the child alone.
- Edit the .tsx/.ts file IN PLACE. Do NOT touch any .json file, i18n/index.ts, or any other source file.
- After editing, re-scan YOUR file: there must be ZERO remaining user-visible CJK string literal, and no unused import, no broken JSX.

RETURN via the schema: file, target_key='${it.key}', keys_used = every '${it.key}.*' key path your file now references (exclude common:*), and the zh + en nested objects for ${namespace}.${it.key} (zh = original Chinese; en = faithful natural English; identical key structure and identical {{placeholders}}).`,
    { label: `i18n:${it.key}`, phase: 'Convert', schema: SCHEMA }
  )
))

return { namespace, converted: results.filter(Boolean) }
