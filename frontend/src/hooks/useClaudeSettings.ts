import { useQuery } from '@tanstack/react-query';
import { claudeSettingsApi, type ClaudeSettings } from '@/lib/api';

const CLAUDE_SETTINGS_KEY = 'claudeSettings';

export function useClaudeSettings() {
  const { data, error, isLoading } = useQuery<ClaudeSettings>({
    queryKey: [CLAUDE_SETTINGS_KEY],
    queryFn: claudeSettingsApi.get,
    retry: false,
  });

  return {
    settings: data ?? null,
    isLoading,
    error:
      error instanceof Error ? error.message : error ? String(error) : null,
  };
}
