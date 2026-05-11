import { materializePromptTagReferences } from '@/lib/tagReferenceMarkers';

const SESSION_SCOPED_SLASH_COMMANDS = new Set([
  'compact',
  'context',
  'cost',
  'status',
  'todos',
  'undo',
  'redo',
  'messages',
  'session',
  'sessions',
]);

export function getSlashCommandName(prompt: string): string | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) return null;

  const match = /^\/([^\s/]+)(?:\s|$)/.exec(trimmed);
  if (!match) return null;

  return match[1].toLowerCase();
}

function isSlashCommandPrompt(prompt: string): boolean {
  return getSlashCommandName(prompt) !== null;
}

export function isSessionScopedSlashCommand(prompt: string): boolean {
  const commandName = getSlashCommandName(prompt);
  return commandName !== null && SESSION_SCOPED_SLASH_COMMANDS.has(commandName);
}

export function buildAgentPrompt(
  rawUserMessage: string,
  contextParts: (string | null | undefined)[]
) {
  const trimmed = rawUserMessage.trim();
  const isSlashCommand = !!trimmed && isSlashCommandPrompt(trimmed);
  const materializedUserMessage =
    materializePromptTagReferences(rawUserMessage);

  const parts = isSlashCommand
    ? [trimmed]
    : [...contextParts, materializedUserMessage].filter(Boolean);

  return {
    prompt: parts.join('\n\n'),
    isSlashCommand,
  };
}
