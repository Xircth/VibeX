import { settingsWindowApi } from '@/lib/api';

export const AGENT_SETTINGS_FOCUS_KEY = 'vibex:settings-agent-focus';

export type AgentSettingsFocus = {
  agentId: string;
  focusDiagnostics: boolean;
};

export function openAgentDiagnostics(agentId: string): void {
  const focus: AgentSettingsFocus = {
    agentId,
    focusDiagnostics: true,
  };
  localStorage.setItem(AGENT_SETTINGS_FOCUS_KEY, JSON.stringify(focus));
  void settingsWindowApi.open();
}

export function consumeAgentSettingsFocus(): AgentSettingsFocus | null {
  const raw = localStorage.getItem(AGENT_SETTINGS_FOCUS_KEY);
  if (!raw) return null;
  localStorage.removeItem(AGENT_SETTINGS_FOCUS_KEY);
  try {
    const parsed = JSON.parse(raw) as Partial<AgentSettingsFocus>;
    if (typeof parsed.agentId !== 'string' || parsed.agentId.length === 0) {
      return null;
    }
    return {
      agentId: parsed.agentId,
      focusDiagnostics: parsed.focusDiagnostics === true,
    };
  } catch {
    return null;
  }
}
