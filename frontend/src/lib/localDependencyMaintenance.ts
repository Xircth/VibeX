import i18n from '@/i18n';
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
  opencode: 'opencode',
};

function formatVersion(
  version: string | null,
  fallback = i18n.t('app:localDeps.notInstalled')
): string {
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

  return (
    tools.find((tool) => tool.user_visible && tool.group_id === groupId) ?? null
  );
}

export function getLocalDependencyVersionSummary(
  tool: LocalToolStatus
): string {
  const parts = [
    i18n.t('app:localDeps.versionSummary.current', {
      version: formatVersion(tool.installed_version),
    }),
  ];

  if (tool.minimum_supported_version) {
    parts.push(
      i18n.t('app:localDeps.versionSummary.minimum', {
        version: tool.minimum_supported_version,
      })
    );
  }

  if (tool.latest_version) {
    parts.push(
      i18n.t('app:localDeps.versionSummary.latest', {
        version: tool.latest_version,
      })
    );
  }

  return parts.join(' / ');
}

export function getLocalDependencyStatusPresentation(
  tool: LocalToolStatus
): LocalDependencyStatusPresentation {
  if (!tool.installed) {
    return {
      label: i18n.t('app:localDeps.status.missing.label'),
      tone: 'destructive',
      summary: i18n.t('app:localDeps.status.missing.summary', {
        label: tool.label,
      }),
      detail: i18n.t('app:localDeps.status.missing.detail'),
      actionLabel: i18n.t('app:localDeps.status.missing.action'),
    };
  }

  if (!tool.supported) {
    return {
      label: i18n.t('app:localDeps.status.incompatible.label'),
      tone: 'warning',
      summary: i18n.t('app:localDeps.status.incompatible.summary', {
        current: formatVersion(tool.installed_version),
        minimum: formatVersion(
          tool.minimum_supported_version,
          i18n.t('app:localDeps.unknown')
        ),
      }),
      detail: i18n.t('app:localDeps.status.incompatible.detail'),
      actionLabel: i18n.t('app:localDeps.status.incompatible.action'),
    };
  }

  if (tool.update_available) {
    return {
      label: i18n.t('app:localDeps.status.updateAvailable.label'),
      tone: 'warning',
      summary: i18n.t('app:localDeps.status.updateAvailable.summary', {
        current: formatVersion(tool.installed_version),
        latest: formatVersion(
          tool.latest_version,
          i18n.t('app:localDeps.unknown')
        ),
      }),
      detail: i18n.t('app:localDeps.status.updateAvailable.detail'),
      actionLabel: i18n.t('app:localDeps.status.updateAvailable.action'),
    };
  }

  return {
    label: i18n.t('app:localDeps.status.compatible.label'),
    tone: 'success',
    summary: i18n.t('app:localDeps.status.compatible.summary', {
      current: formatVersion(tool.installed_version),
    }),
    detail: i18n.t('app:localDeps.status.compatible.detail'),
    actionLabel: null,
  };
}
