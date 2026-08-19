import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Config, type Environment } from 'shared/types';
import type { ExecutorConfig } from 'shared/types';
import {
  configApi,
  type AgentCapability,
  type UserSystemInfo,
} from '../lib/api';
import {
  SETTINGS_CHANGED_EVENT,
  syncFrontendPreferences,
} from '@/lib/frontendPreferences';
import { initUiZoom } from '@/lib/uiZoom';
import { initMonoFont } from '@/lib/uiFont';
import { getUiLanguage } from '@/lib/uiLanguage';
import i18n from '@/i18n';
import { useEditorSettingsStore } from '@/stores/useEditorSettingsStore';
import { useKeyBindingOverridesStore } from '@/keyboard/useKeyBindingOverrides';
import { backendListen } from '@/lib/backendTransport';

interface UserSystemState {
  config: Config | null;
  environment: Environment | null;
  profiles: Record<string, ExecutorConfig> | null;
  capabilities: Record<string, AgentCapability[]> | null;
}

interface UserSystemContextType {
  // Full system state
  system: UserSystemState;

  // Hot path - config helpers (most frequently used)
  config: Config | null;
  updateConfig: (updates: Partial<Config>) => void;
  updateAndSaveConfig: (updates: Partial<Config>) => Promise<boolean>;
  saveConfig: () => Promise<boolean>;

  // System data access
  environment: Environment | null;
  profiles: Record<string, ExecutorConfig> | null;
  capabilities: Record<string, AgentCapability[]> | null;
  setEnvironment: (env: Environment | null) => void;
  setProfiles: (profiles: Record<string, ExecutorConfig> | null) => void;
  setCapabilities: (caps: Record<string, AgentCapability[]> | null) => void;

  // Reload system data
  reloadSystem: () => Promise<void>;

  // State
  loading: boolean;
}

const UserSystemContext = createContext<UserSystemContextType | undefined>(
  undefined
);

interface UserSystemProviderProps {
  children: ReactNode;
}

export function UserSystemProvider({ children }: UserSystemProviderProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: () => void = () => undefined;
    let disposed = false;
    const sync = async () => {
      try {
        await syncFrontendPreferences();
        initUiZoom();
        initMonoFont();
        const nextLanguage = getUiLanguage();
        if (i18n.language !== nextLanguage) {
          await i18n.changeLanguage(nextLanguage);
        }
        await Promise.all([
          useEditorSettingsStore.persist.rehydrate(),
          useKeyBindingOverridesStore.persist.rehydrate(),
        ]);
      } catch (error) {
        console.error('Failed to synchronize JSON frontend settings', error);
      }
    };
    const handleSettingsChanged = () => {
      void sync();
      void queryClient.invalidateQueries({ queryKey: ['user-system'] });
      window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
    };

    void sync();
    window.addEventListener('focus', sync);
    void backendListen(SETTINGS_CHANGED_EVENT, handleSettingsChanged).then(
      (stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      }
    );
    return () => {
      disposed = true;
      unlisten();
      window.removeEventListener('focus', sync);
    };
  }, [queryClient]);

  const { data: userSystemInfo, isLoading } = useQuery({
    queryKey: ['user-system'],
    queryFn: configApi.getConfig,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: 'always',
  });

  const config = userSystemInfo?.config || null;
  const environment = userSystemInfo?.environment || null;
  const profiles =
    (userSystemInfo?.executors as Record<string, ExecutorConfig> | null) ||
    null;
  const capabilities =
    (userSystemInfo?.capabilities as Record<
      string,
      AgentCapability[]
    > | null) || null;

  const updateConfig = useCallback(
    (updates: Partial<Config>) => {
      queryClient.setQueryData<UserSystemInfo>(['user-system'], (old) => {
        if (!old) return old;
        return {
          ...old,
          config: { ...old.config, ...updates },
        };
      });
    },
    [queryClient]
  );

  const saveConfig = useCallback(async (): Promise<boolean> => {
    if (!config) return false;
    try {
      await configApi.saveConfig(config);
      return true;
    } catch (err) {
      console.error('Error saving config:', err);
      return false;
    }
  }, [config]);

  const updateAndSaveConfig = useCallback(
    async (updates: Partial<Config>): Promise<boolean> => {
      if (!config) return false;

      const newConfig = { ...config, ...updates };
      updateConfig(updates);

      try {
        const saved = await configApi.saveConfig(newConfig);
        queryClient.setQueryData<UserSystemInfo>(['user-system'], (old) => {
          if (!old) return old;
          return {
            ...old,
            config: saved,
          };
        });
        return true;
      } catch (err) {
        console.error('Error saving config:', err);
        queryClient.invalidateQueries({ queryKey: ['user-system'] });
        return false;
      }
    },
    [config, queryClient, updateConfig]
  );

  const reloadSystem = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['user-system'] });
  }, [queryClient]);

  const setEnvironment = useCallback(
    (env: Environment | null) => {
      queryClient.setQueryData<UserSystemInfo>(['user-system'], (old) => {
        if (!old || !env) return old;
        return { ...old, environment: env };
      });
    },
    [queryClient]
  );

  const setProfiles = useCallback(
    (newProfiles: Record<string, ExecutorConfig> | null) => {
      queryClient.setQueryData<UserSystemInfo>(['user-system'], (old) => {
        if (!old || !newProfiles) return old;
        return {
          ...old,
          executors: newProfiles as unknown as UserSystemInfo['executors'],
        };
      });
    },
    [queryClient]
  );

  const setCapabilities = useCallback(
    (newCapabilities: Record<string, AgentCapability[]> | null) => {
      queryClient.setQueryData<UserSystemInfo>(['user-system'], (old) => {
        if (!old || !newCapabilities) return old;
        return { ...old, capabilities: newCapabilities };
      });
    },
    [queryClient]
  );

  // Memoize context value to prevent unnecessary re-renders
  const value = useMemo<UserSystemContextType>(
    () => ({
      system: {
        config,
        environment,
        profiles,
        capabilities,
      },
      config,
      environment,
      profiles,
      capabilities,
      updateConfig,
      saveConfig,
      updateAndSaveConfig,
      setEnvironment,
      setProfiles,
      setCapabilities,
      reloadSystem,
      loading: isLoading,
    }),
    [
      config,
      environment,
      profiles,
      capabilities,
      updateConfig,
      saveConfig,
      updateAndSaveConfig,
      reloadSystem,
      isLoading,
      setEnvironment,
      setProfiles,
      setCapabilities,
    ]
  );

  return (
    <UserSystemContext.Provider value={value}>
      {children}
    </UserSystemContext.Provider>
  );
}

export function useUserSystem() {
  const context = useContext(UserSystemContext);
  if (context === undefined) {
    throw new Error('useUserSystem must be used within a UserSystemProvider');
  }
  return context;
}

/** Like useUserSystem, but returns null outside a UserSystemProvider. */
export function useOptionalUserSystem() {
  return useContext(UserSystemContext) ?? null;
}
