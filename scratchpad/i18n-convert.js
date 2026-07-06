export const meta = {
  name: 'i18n-convert',
  description: 'Convert a batch of files to react-i18next under a target namespace, returning key subtrees',
  phases: [{ title: 'Convert' }],
}

// Edit NAMESPACE + ITEMS per wave, then re-invoke with this scriptPath.
const REPO = '/Users/sean/Documents/Projetcs/VibeX'
const namespace = 'conversation'
const items = [
  { file: 'frontend/src/components/NormalizedConversation/DisplayConversationEntry.tsx', key: 'displayEntry' },
  { file: 'frontend/src/components/NormalizedConversation/FileContentView.tsx', key: 'fileContentView' },
  { file: 'frontend/src/components/NormalizedConversation/LoadingCard.tsx', key: 'loadingCard' },
  { file: 'frontend/src/components/NormalizedConversation/MessageTurnView.tsx', key: 'messageTurnView' },
  { file: 'frontend/src/components/NormalizedConversation/NextActionCard.tsx', key: 'nextActionCard' },
  { file: 'frontend/src/components/NormalizedConversation/PendingApprovalEntry.tsx', key: 'pendingApproval' },
  { file: 'frontend/src/components/NormalizedConversation/RetryEditorInline.tsx', key: 'retryEditor' },
  { file: 'frontend/src/components/NormalizedConversation/ThinkingEntry.tsx', key: 'thinking' },
  { file: 'frontend/src/components/NormalizedConversation/UserMessage.tsx', key: 'userMessage' },
  { file: 'frontend/src/components/NormalizedConversation/conversation/DelegationCard.tsx', key: 'delegationCard' },
  { file: 'frontend/src/components/NormalizedConversation/conversation/GeneratedImageCard.tsx', key: 'generatedImageCard' },
  { file: 'frontend/src/components/NormalizedConversation/conversation/PermissionRequestCard.tsx', key: 'permissionRequestCard' },
  { file: 'frontend/src/components/NormalizedConversation/conversation/TurnErrorCard.tsx', key: 'turnErrorCard' },
  { file: 'frontend/src/components/NormalizedConversation/tools/AskQuestionResultCard.tsx', key: 'askQuestion' },
  { file: 'frontend/src/components/NormalizedConversation/tools/CommandToolCard.tsx', key: 'commandTool' },
  { file: 'frontend/src/components/NormalizedConversation/tools/FeedbackCheckResultCard.tsx', key: 'feedbackCheck' },
  { file: 'frontend/src/components/NormalizedConversation/tools/FileToolCard.tsx', key: 'fileTool' },
  { file: 'frontend/src/components/NormalizedConversation/tools/GeneratedImagesBlock.tsx', key: 'generatedImages' },
  { file: 'frontend/src/components/NormalizedConversation/tools/GenericToolCard.tsx', key: 'genericTool' },
  { file: 'frontend/src/components/NormalizedConversation/tools/GoalToolCall.tsx', key: 'goalTool' },
  { file: 'frontend/src/components/NormalizedConversation/tools/PlanCard.tsx', key: 'planCard' },
  { file: 'frontend/src/components/NormalizedConversation/tools/SearchToolCard.tsx', key: 'searchTool' },
  { file: 'frontend/src/components/conversation-thread/ConversationMessageNav.tsx', key: 'messageNav' },
  { file: 'frontend/src/components/conversation-thread/TurnStats.tsx', key: 'turnStats' },
  { file: 'frontend/src/features/conversation/ConversationBundle.tsx', key: 'bundle' },
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
