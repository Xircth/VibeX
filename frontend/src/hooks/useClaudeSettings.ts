import { useQuery } from '@tanstack/react-query';
import { claudeSettingsApi, fileTreeApi, type ClaudeSettings } from '@/lib/api';

const CLAUDE_SETTINGS_KEY = 'claudeSettings';

async function fetchClaudeSettings(): Promise<ClaudeSettings> {
  // Primary: use Tauri get_claude_settings command
  try {
    const settings = await claudeSettingsApi.get();
    // If enabled_plugins is non-empty, use the result directly
    if (Object.keys(settings.enabled_plugins ?? {}).length > 0) {
      return settings;
    }
    // enabled_plugins is empty — could be binary not recompiled or genuinely empty.
    // Attempt fallback: read & parse settings.json directly via file API.
  } catch {
    // Primary command failed, try fallback
  }

  // Fallback: read ~/.claude/settings.json directly via file system API
  try {
    const settingsPath = await fileTreeApi.getClaudeSettingsPath();
    if (!settingsPath) return { env: {}, enabled_plugins: {} };
    const raw = await fileTreeApi.readFile(settingsPath);
    const json = JSON.parse(raw) as Record<string, unknown>;
    const env = (json['env'] ?? {}) as Record<string, string>;
    const enabledPlugins = (json['enabledPlugins'] ?? {}) as Record<string, boolean>;
    return { env, enabled_plugins: enabledPlugins };
  } catch {
    return { env: {}, enabled_plugins: {} };
  }
}

export function useClaudeSettings() {
  const { data, isLoading } = useQuery<ClaudeSettings>({
    queryKey: [CLAUDE_SETTINGS_KEY],
    queryFn: fetchClaudeSettings,
  });

  return {
    settings: data ?? null,
    isLoading,
  };
}
