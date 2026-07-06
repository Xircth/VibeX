export const meta = {
  name: 'i18n-convert',
  description: 'Convert a batch of files to react-i18next under a target namespace, returning key subtrees',
  phases: [{ title: 'Convert' }],
}

// Edit NAMESPACE + ITEMS per wave, then re-invoke with this scriptPath.
const REPO = '/Users/sean/Documents/Projetcs/VibeX'
const namespace = 'panels'
const items = [
  { file: 'frontend/src/components/panels/DockviewKanbanPanel.tsx', key: 'kanbanPanel' },
  { file: 'frontend/src/components/panels/PreviewPanel.tsx', key: 'previewPanel' },
  { file: 'frontend/src/components/panels/DockviewDiffsReviewPanel.tsx', key: 'diffsReviewPanel' },
  { file: 'frontend/src/components/panels/DiffsPanel.tsx', key: 'diffsPanel' },
  { file: 'frontend/src/components/panels/DockviewWelcomePanel.tsx', key: 'welcomePanel' },
  { file: 'frontend/src/components/panels/DockviewFileTreePanel.tsx', key: 'fileTreePanel' },
  { file: 'frontend/src/components/panels/DockviewTerminalPanel.tsx', key: 'terminalPanel' },
  { file: 'frontend/src/components/panels/DockviewLogsPanel.tsx', key: 'logsPanel' },
  { file: 'frontend/src/components/panels/DockviewPreviewPanel.tsx', key: 'dockPreviewPanel' },
  { file: 'frontend/src/components/panels/DockviewSearchPanel.tsx', key: 'searchPanel' },
  { file: 'frontend/src/components/panels/git/GitStashSection.tsx', key: 'gitStash' },
  { file: 'frontend/src/components/layout/BranchInfoHeader.tsx', key: 'branchInfo' },
  { file: 'frontend/src/components/layout/Toolbar.tsx', key: 'toolbar' },
  { file: 'frontend/src/components/layout/ProjectActivityUi.tsx', key: 'projectActivity' },
  { file: 'frontend/src/components/layout/WorktreeSelector.tsx', key: 'worktreeSelector' },
  { file: 'frontend/src/components/layout/ProjectRailToggleButton.tsx', key: 'railToggle' },
  { file: 'frontend/src/components/layout/IDELayout.tsx', key: 'ideLayout' },
  { file: 'frontend/src/components/layout/ProjectRail.tsx', key: 'projectRail' },
  { file: 'frontend/src/components/layout/ProjectWindowManager.tsx', key: 'windowManager' },
  { file: 'frontend/src/components/layout/RightPanelContent.tsx', key: 'rightPanelContent' },
  { file: 'frontend/src/components/layout/panels/TerminalHeaderActions.tsx', key: 'terminalHeader' },
  { file: 'frontend/src/components/layout/RightPanelNewSessionPrompt.tsx', key: 'newSessionPrompt' },
  { file: 'frontend/src/components/layout/RightPanelSidebar.tsx', key: 'rightPanelSidebar' },
  { file: 'frontend/src/components/layout/panels/PanelRegistry.tsx', key: 'panelRegistry' },
  { file: 'frontend/src/components/file-tree/FileTreePanel.tsx', key: 'fileTreeMenu' },
  { file: 'frontend/src/components/logs/AgentTimelineConversation.tsx', key: 'timeline' },
  { file: 'frontend/src/components/search/SearchPalette.tsx', key: 'searchPalette' },
  { file: 'frontend/src/components/ide/IdeIcon.tsx', key: 'ideIcon' },
  { file: 'frontend/src/components/desktop-toast/DesktopToastWindow.tsx', key: 'desktopToast' },
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
