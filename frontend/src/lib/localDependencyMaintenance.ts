import type { LocalToolStatus } from '@/lib/api';

type LocalDependencyTone = 'destructive' | 'warning' | 'success' | 'muted';

export interface LocalDependencyStatusPresentation {
  label: string;
  tone: LocalDependencyTone;
  summary: string;
  detail: string;
  actionLabel: string | null;
}

const AGENT_DEPENDENCY_GROUPS: Record<string, string> = {
  claude_code: 'claude',
  codex: 'codex',
  open_code: 'opencode',
};

function formatVersion(version: string | null, fallback = '未安装'): string {
  return version && version.trim().length > 0 ? version : fallback;
}

export function getAgentDependencyTool(
  agentType: string,
  tools: LocalToolStatus[]
): LocalToolStatus | null {
  const groupId = AGENT_DEPENDENCY_GROUPS[agentType];
  if (!groupId) {
    return null;
  }

  return tools.find((tool) => tool.user_visible && tool.group_id === groupId) ?? null;
}

export function getLocalDependencyVersionSummary(
  tool: LocalToolStatus
): string {
  const parts = [`当前版本：${formatVersion(tool.installed_version)}`];

  if (tool.minimum_supported_version) {
    parts.push(`最低支持：${tool.minimum_supported_version}`);
  }

  if (tool.latest_version) {
    parts.push(`最新版本：${tool.latest_version}`);
  }

  return parts.join(' / ');
}

export function getLocalDependencyStatusPresentation(
  tool: LocalToolStatus
): LocalDependencyStatusPresentation {
  if (!tool.installed) {
    return {
      label: '缺失',
      tone: 'destructive',
      summary: `尚未检测到 ${tool.label} 的本地安装。`,
      detail: '安装时会同时补齐该 Agent 所需的隐藏依赖。',
      actionLabel: '安装',
    };
  }

  if (!tool.supported) {
    return {
      label: '版本不兼容',
      tone: 'warning',
      summary: `当前版本 ${formatVersion(tool.installed_version)} 低于最低要求 ${formatVersion(tool.minimum_supported_version, '未知')}。`,
      detail: '更新时会同时处理该 Agent 的隐藏依赖。',
      actionLabel: '更新',
    };
  }

  if (tool.update_available) {
    return {
      label: '可更新',
      tone: 'warning',
      summary: `当前版本 ${formatVersion(tool.installed_version)}，检测到更高版本 ${formatVersion(tool.latest_version, '未知')}。`,
      detail: '更新时会同时处理该 Agent 的隐藏依赖。',
      actionLabel: '更新',
    };
  }

  return {
    label: '已兼容',
    tone: 'success',
    summary: `当前版本 ${formatVersion(tool.installed_version)} 已满足 VibeX 运行要求。`,
    detail: '当前安装满足要求，无需额外处理。',
    actionLabel: null,
  };
}
