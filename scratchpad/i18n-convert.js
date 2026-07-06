export const meta = {
  name: 'i18n-convert',
  description: 'Convert a batch of files to react-i18next under a target namespace, returning key subtrees',
  phases: [{ title: 'Convert' }],
}

// Edit NAMESPACE + ITEMS per wave, then re-invoke with this scriptPath.
const REPO = '/Users/sean/Documents/Projetcs/VibeX'
const namespace = 'app'
const items = [
  { file: 'frontend/src/App.tsx', key: 'shell' },
  { file: 'frontend/src/components/AgentAvailabilityIndicator.tsx', key: 'agentAvailability' },
  { file: 'frontend/src/components/AppErrorBoundary.tsx', key: 'errorBoundary' },
  { file: 'frontend/src/components/DiffCard.tsx', key: 'diffCard' },
  { file: 'frontend/src/components/DiffViewSwitch.tsx', key: 'diffViewSwitch' },
  { file: 'frontend/src/components/EditorAvailabilityIndicator.tsx', key: 'editorAvailability' },
  { file: 'frontend/src/components/TagManager.tsx', key: 'tagManager' },
  { file: 'frontend/src/components/projects/ProjectCard.tsx', key: 'projectCard' },
  { file: 'frontend/src/components/projects/ProjectList.tsx', key: 'projectList' },
  { file: 'frontend/src/components/showcase/ShowcaseStageMedia.tsx', key: 'showcaseMedia' },
  { file: 'frontend/src/components/ui/breadcrumb.tsx', key: 'breadcrumb' },
  { file: 'frontend/src/components/ui/pr-comment-card.tsx', key: 'prCommentCard' },
  { file: 'frontend/src/components/ui/shadcn-io/kanban/index.tsx', key: 'kanbanBoard' },
  { file: 'frontend/src/components/ui/wysiwyg/plugins/slash-command-typeahead-plugin.tsx', key: 'slashCommand' },
  { file: 'frontend/src/components/welcome/WelcomePage.tsx', key: 'welcomePage' },
  { file: 'frontend/src/pages/FullAttemptLogs.tsx', key: 'fullAttemptLogs' },
  { file: 'frontend/src/hooks/useFollowUpSend.ts', key: 'followUpSend' },
  { file: 'frontend/src/hooks/useKanbanProjectSessions.ts', key: 'kanbanSessions' },
  { file: 'frontend/src/hooks/useWorkspaceSessions.ts', key: 'workspaceSessions' },
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
