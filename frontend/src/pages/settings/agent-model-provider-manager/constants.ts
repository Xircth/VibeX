// `model` fields hold a model id and can be picked from the detected catalog;
// `text` fields (the custom option's display name and description) are prose.
export const CLAUDE_MODEL_FIELDS = [
  ['main', 'providerModelMain', 'model'],
  ['reasoning', 'providerModelReasoning', 'model'],
  ['haiku', 'providerModelHaiku', 'model'],
  ['sonnet', 'providerModelSonnet', 'model'],
  ['opus', 'providerModelOpus', 'model'],
  ['customOption', 'providerModelCustomId', 'model'],
  ['customOptionName', 'providerModelCustomName', 'text'],
  ['customOptionDescription', 'providerModelCustomDescription', 'text'],
] as const;

export const CLAUDE_DETECTED_MODEL_TARGETS = CLAUDE_MODEL_FIELDS.filter(
  ([key]) => !['customOptionName', 'customOptionDescription'].includes(key)
);

/** Menu value that switches the field over to free-text entry. */
export const CUSTOM_MODEL_SENTINEL = '__custom__';

export const PI_PROTOCOLS = [
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
  'google-generative-ai',
] as const;
