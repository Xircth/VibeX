import { useEffect, useState, useCallback } from 'react';
import type { BaseCodingAgent } from 'shared/types';
import {
  readAgentNativeConfigs,
  writeAgentNativeConfig,
  type AgentNativeConfigs,
} from '@/lib/agentNativeConfig';

interface UseAgentNativeConfigResult {
  /** Native configs data, null while loading or on error */
  data: AgentNativeConfigs | null;
  /** Whether the data is currently loading */
  isLoading: boolean;
  /** Error message if the load failed */
  error: string | null;
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** Re-fetch native configs from disk */
  refetch: () => void;
  /** Write native config files to disk */
  save: (params: {
    codexConfigToml?: string | null;
    codexAuthJson?: string | null;
    opencodeConfigJson?: string | null;
    opencodeAuthJson?: string | null;
  }) => Promise<void>;
}

/**
 * Hook to read and write agent native configuration files
 * (e.g. ~/.codex/config.toml, ~/.codex/auth.json).
 */
export function useAgentNativeConfig(
  agentType: BaseCodingAgent | null
): UseAgentNativeConfigResult {
  const [data, setData] = useState<AgentNativeConfigs | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const fetchData = useCallback(async () => {
    if (!agentType) {
      setData(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await readAgentNativeConfigs(agentType);
      setData(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [agentType]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const save = useCallback(
    async (params: {
      codexConfigToml?: string | null;
      codexAuthJson?: string | null;
      opencodeConfigJson?: string | null;
      opencodeAuthJson?: string | null;
    }) => {
      if (!agentType) return;

      setIsSaving(true);
      try {
        await writeAgentNativeConfig({
          agentType,
          ...params,
        });
        // Re-fetch after successful save
        await fetchData();
      } finally {
        setIsSaving(false);
      }
    },
    [agentType, fetchData]
  );

  return {
    data,
    isLoading,
    error,
    isSaving,
    refetch: fetchData,
    save,
  };
}
