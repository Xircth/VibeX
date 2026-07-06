export const meta = {
  name: 'i18n-convert',
  description: 'Convert a batch of files to react-i18next under a target namespace, returning key subtrees',
  phases: [{ title: 'Convert' }],
}

// Edit NAMESPACE + ITEMS per wave, then re-invoke with this scriptPath.
const REPO = '/Users/sean/Documents/Projetcs/VibeX'
const namespace = 'dialogs'
const items = [
  { file: 'frontend/src/components/dialogs/tasks/PrCommentsDialog.tsx', key: 'prComments' },
  { file: 'frontend/src/components/dialogs/tasks/GitActionsDialog.tsx', key: 'gitActions' },
  { file: 'frontend/src/components/dialogs/tasks/CreatePRDialog.tsx', key: 'createPr' },
  { file: 'frontend/src/components/dialogs/tasks/EditBranchNameDialog.tsx', key: 'editBranchName' },
  { file: 'frontend/src/components/dialogs/tasks/RebaseDialog.tsx', key: 'rebase' },
  { file: 'frontend/src/components/dialogs/tasks/TagEditDialog.tsx', key: 'tagEdit' },
  { file: 'frontend/src/components/dialogs/tasks/ChangeTargetBranchDialog.tsx', key: 'changeTargetBranch' },
  { file: 'frontend/src/components/dialogs/auth/GhCliSetupDialog.tsx', key: 'ghCliSetup' },
  { file: 'frontend/src/components/dialogs/tasks/RestoreLogsDialog.tsx', key: 'restoreLogs' },
  { file: 'frontend/src/components/dialogs/tasks/ViewProcessesDialog.tsx', key: 'viewProcesses' },
  { file: 'frontend/src/components/dialogs/shared/FolderPickerDialog.tsx', key: 'folderPicker' },
  { file: 'frontend/src/components/dialogs/projects/CloneRepoDialog.tsx', key: 'cloneRepo' },
  { file: 'frontend/src/components/dialogs/projects/ProjectFormDialog.tsx', key: 'projectForm' },
  { file: 'frontend/src/components/dialogs/global/DisclaimerDialog.tsx', key: 'disclaimer' },
  { file: 'frontend/src/components/dialogs/global/FeatureShowcaseDialog.tsx', key: 'featureShowcase' },
  { file: 'frontend/src/components/dialogs/git/ForcePushDialog.tsx', key: 'forcePush' },
  { file: 'frontend/src/components/dialogs/scripts/ScriptFixerDialog.tsx', key: 'scriptFixer' },
  { file: 'frontend/src/components/dialogs/global/BetaWorkspacesDialog.tsx', key: 'betaWorkspaces' },
  { file: 'frontend/src/components/dialogs/global/OnboardingDialog.tsx', key: 'onboarding' },
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
