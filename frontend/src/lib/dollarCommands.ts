import type { AgentLocalSkill } from '@/lib/api';

export type DollarCommandDescription = {
  name: string;
  description?: string;
};

export const DOLLAR_COMMANDS: DollarCommandDescription[] = [
  { name: 'autopilot', description: 'Run autonomous implementation workflow' },
  { name: 'plan', description: 'Start the planning workflow' },
  {
    name: 'deep-interview',
    description: 'Run the requirements interview workflow',
  },
  { name: 'ralplan', description: 'Run consensus planning' },
  { name: 'ralph', description: 'Run the completion loop workflow' },
  { name: 'ultrawork', description: 'Run high-throughput parallel workflow' },
  { name: 'ultraqa', description: 'Run persistent verification workflow' },
  { name: 'team', description: 'Run coordinated team workflow' },
  { name: 'swarm', description: 'Alias for coordinated team workflow' },
  { name: 'ecomode', description: 'Run cost-aware workflow mode' },
  { name: 'cancel', description: 'Cancel an active workflow mode' },
  { name: 'trace', description: 'Show orchestration trace state' },
  { name: 'note', description: 'Save a durable session note' },
  { name: 'help', description: 'Show oh-my-codex help' },
  { name: 'doctor', description: 'Diagnose oh-my-codex installation issues' },
  { name: 'hud', description: 'Show or configure the OMX HUD' },
  { name: 'tdd', description: 'Run a test-first workflow' },
  { name: 'fix-build', description: 'Fix build or type errors' },
  { name: 'analyze', description: 'Run root-cause analysis' },
  { name: 'code-review', description: 'Request a code review workflow' },
  {
    name: 'security-review',
    description: 'Request a security review workflow',
  },
  { name: 'ai-slop-cleaner', description: 'Run cleanup and refactor workflow' },
  { name: 'web-clone', description: 'Start the web clone workflow' },
  { name: 'visual-verdict', description: 'Run structured visual QA' },
  { name: 'ask-claude', description: 'Ask Claude through the local CLI' },
  { name: 'ask-gemini', description: 'Ask Gemini through the local CLI' },
  { name: 'configure-notifications', description: 'Configure notifications' },
  { name: 'browser-use', description: 'Use the in-app browser workflow' },
  { name: 'openai-docs', description: 'Look up official OpenAI docs' },
  { name: 'shadcn', description: 'Work with shadcn/ui components' },
  { name: 'skill', description: 'Manage local Codex skills' },
  { name: 'skill-installer', description: 'Install Codex skills' },
  { name: 'skill-creator', description: 'Create or improve a Codex skill' },
  { name: 'plugin-creator', description: 'Create a local Codex plugin' },
];

export function skillsToDollarCommands(
  skills: AgentLocalSkill[]
): DollarCommandDescription[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description ?? `Local Codex skill: ${skill.path}`,
  }));
}

export function mergeDollarCommands(
  staticCommands: DollarCommandDescription[],
  skillCommands: DollarCommandDescription[]
): DollarCommandDescription[] {
  const seen = new Set<string>();
  const commands: DollarCommandDescription[] = [];

  for (const command of [...staticCommands, ...skillCommands]) {
    const name = command.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    commands.push({ ...command, name });
  }

  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

export function filterDollarCommands(
  all: DollarCommandDescription[],
  query: string
): DollarCommandDescription[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;

  const startsWith = all.filter((command) =>
    command.name.toLowerCase().startsWith(q)
  );
  const includes = all.filter(
    (command) =>
      !startsWith.includes(command) && command.name.toLowerCase().includes(q)
  );
  return [...startsWith, ...includes];
}
