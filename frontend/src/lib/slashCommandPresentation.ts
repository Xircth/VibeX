import { BaseCodingAgent, type SlashCommandDescription } from 'shared/types';

export type SlashCommandIconKey =
  | 'compact'
  | 'goal'
  | 'review'
  | 'init'
  | 'mcp'
  | 'command';

type SlashCommandPresentation = {
  label: string;
  description: string | null;
  iconKey: SlashCommandIconKey | null;
  isSkill: boolean;
};

const CORE_COMMANDS: Record<
  string,
  { label: string; description: string; iconKey: SlashCommandIconKey }
> = {
  compact: {
    label: '压缩',
    description: '压缩当前会话上下文',
    iconKey: 'compact',
  },
  goal: {
    label: '目标',
    description: '查看或管理当前目标',
    iconKey: 'goal',
  },
  review: {
    label: '审查',
    description: '审查当前代码更改',
    iconKey: 'review',
  },
  init: {
    label: '初始化',
    description: '生成或更新项目指引文件',
    iconKey: 'init',
  },
  mcp: {
    label: 'MCP',
    description: '显示 MCP 服务器状态',
    iconKey: 'mcp',
  },
};

function supportsGoal(executor: BaseCodingAgent | null | undefined): boolean {
  return executor === BaseCodingAgent.CODEX;
}

export function isCoreSlashCommand(
  command: SlashCommandDescription,
  executor: BaseCodingAgent | null | undefined
): boolean {
  const name = command.name.trim().toLowerCase();
  if (name === 'goal') return supportsGoal(executor);
  return name in CORE_COMMANDS;
}

export function isSlashCommandSkill(command: SlashCommandDescription): boolean {
  return command.kind === 'SKILL';
}

export function getSlashCommandPresentation(
  command: SlashCommandDescription,
  executor: BaseCodingAgent | null | undefined
): SlashCommandPresentation {
  const normalizedName = command.name.trim().toLowerCase();
  const core = isCoreSlashCommand(command, executor)
    ? CORE_COMMANDS[normalizedName]
    : null;

  if (core) {
    return {
      ...core,
      isSkill: false,
    };
  }

  return {
    label: command.name,
    description: command.description ?? null,
    iconKey: null,
    isSkill: isSlashCommandSkill(command),
  };
}
