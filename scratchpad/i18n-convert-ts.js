export const meta = {
  name: 'i18n-convert-ts',
  description: 'Convert non-component .ts modules to i18n.t (standalone instance), returning key subtrees',
  phases: [{ title: 'Convert' }],
}

const REPO = '/Users/sean/Documents/Projetcs/VibeX'
const namespace = 'app'
const items = [
  { file: 'frontend/src/components/NormalizedConversation/conversation-entry-utils.ts', key: 'entryUtils' },
  { file: 'frontend/src/components/NormalizedConversation/messageTurnTool.ts', key: 'turnTool' },
  { file: 'frontend/src/components/file-tree/file-tree-utils.ts', key: 'fileTreeUtils' },
  { file: 'frontend/src/config/showcases.ts', key: 'showcases' },
  { file: 'frontend/src/lib/codexGoalState.ts', key: 'codexGoal' },
  { file: 'frontend/src/lib/contextCompact.ts', key: 'contextCompact' },
  { file: 'frontend/src/lib/exportConversation.ts', key: 'exportConversation' },
  { file: 'frontend/src/lib/gitHostUiErrors.ts', key: 'gitHostErrors' },
  { file: 'frontend/src/lib/localDependencyMaintenance.ts', key: 'localDeps' },
  { file: 'frontend/src/lib/searchTagsAndFiles.ts', key: 'searchTags' },
  { file: 'frontend/src/lib/sessionUiErrors.ts', key: 'sessionErrors' },
  { file: 'frontend/src/lib/workspaceBranchOptions.ts', key: 'workspaceBranch' },
  { file: 'frontend/src/utils/date.ts', key: 'date' },
  { file: 'frontend/src/utils/installWebCompanion.ts', key: 'installCompanion' },
  { file: 'frontend/src/utils/sessionContinuity.ts', key: 'sessionContinuity' },
]

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['file', 'target_key', 'keys_used', 'zh', 'en'],
  properties: {
    file: { type: 'string' }, target_key: { type: 'string' },
    keys_used: { type: 'array', items: { type: 'string' } },
    zh: { type: 'object', additionalProperties: true },
    en: { type: 'object', additionalProperties: true },
  },
}

phase('Convert')

const results = await parallel(items.map((it) => () =>
  agent(
    `In ${REPO}, convert the user-visible Chinese strings in the NON-COMPONENT module ${it.file} to i18n.

CRITICAL: this is a plain .ts module (NOT a React component), so you CANNOT use the useTranslation hook. Instead:
- Add \`import i18n from '@/i18n';\` at the top.
- Replace each user-visible Chinese string literal with \`i18n.t('${namespace}:${it.key}.<key>', { ...interpolation })\`. NOTE the namespace prefix form \`${namespace}:key\` is required in standalone i18n.t calls.
- Call i18n.t INSIDE the function that returns/uses the string (so it reflects the current language at call time), NOT at module top-level const initialization. If a Chinese string is currently a module-level const, convert it to a function or move the i18n.t call into the consuming function — but ONLY if that's a small, safe refactor; if it would be invasive, leave that particular const and note it.
- Use \`i18n.t('common:save')\` etc. for shared verbs where applicable.
- Preserve ALL {{placeholders}} identically in zh and en.
- Do NOT convert: code comments, non-CJK strings, enum/id values, or test-fixture data. Only real user-visible strings.
- Edit the .ts file IN PLACE. Do NOT touch any .json / i18n/index.ts / other file.
- Re-scan: zero remaining user-visible CJK string literal (comments may keep CJK).

RETURN via schema: file, target_key='${it.key}', keys_used = every '${it.key}.*' path referenced (exclude common:*), and zh + en nested objects for ${namespace}.${it.key} (zh = original Chinese, en = faithful English, identical structure + placeholders).`,
    { label: `i18n-ts:${it.key}`, phase: 'Convert', schema: SCHEMA }
  )
))

return { namespace, converted: results.filter(Boolean) }
