import { pickHostFile } from '@/lib/hostFs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/toast';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import type { BackendTransport } from '@/lib/backendTransport';
import {
  createPluginControlApi,
  type PluginCliImportEvent,
  type PluginCliImportResult,
  type PluginContributionCatalog,
  type PluginControlCatalog,
  type PluginControlItem,
  type PluginImportPackageKind,
  type PluginImportPreview,
} from '@/lib/api/plugins';
import { getInvokeErrorMessage } from '@/lib/errors';
import { useBackendTransport } from '@/lib/transport';
import {
  pluginEcosystem,
  runtimeLockIsReady,
  type PluginEcosystem,
} from './pluginConstants';

export function usePluginsSettings({
  transport: transportOverride,
  ecosystem,
}: {
  transport?: BackendTransport;
  ecosystem?: PluginEcosystem;
}) {
  const contextTransport = useBackendTransport();
  const transport = transportOverride ?? contextTransport;
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const appSurfaceTransport = useMemo(
    () => createBackendAppSurfaceTransport(transport),
    [transport]
  );
  const { t } = useTranslation(['settings', 'common']);
  const [catalog, setCatalog] = useState<PluginControlCatalog | null>(null);
  const [contributionCatalog, setContributionCatalog] =
    useState<PluginContributionCatalog | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PluginEcosystem>(
    ecosystem ?? 'codex'
  );
  const effectiveTab = ecosystem ?? activeTab;
  const [queries, setQueries] = useState<Record<PluginEcosystem, string>>({
    codex: '',
    claude_code: '',
    vibex: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [importChooserOpen, setImportChooserOpen] = useState(false);
  const [importEcosystem, setImportEcosystem] =
    useState<PluginEcosystem>('codex');
  const [cliCommand, setCliCommand] = useState('');
  const [cliLogs, setCliLogs] = useState<string[]>([]);
  const [cliImportStatus, setCliImportStatus] = useState<
    'idle' | 'running' | 'succeeded' | 'failed'
  >('idle');
  const [cliImportResult, setCliImportResult] =
    useState<PluginCliImportResult | null>(null);
  const [cliImportError, setCliImportError] = useState<string | null>(null);
  const [importPackageKind, setImportPackageKind] =
    useState<PluginImportPackageKind | null>(null);
  const [importPreview, setImportPreview] =
    useState<PluginImportPreview | null>(null);
  const [developerLink, setDeveloperLink] = useState(false);
  const [capabilitySetup, setCapabilitySetup] =
    useState<PluginControlItem | null>(null);
  const [uninstallTarget, setUninstallTarget] =
    useState<PluginControlItem | null>(null);
  const [backendCapabilities, setBackendCapabilities] = useState<Set<string>>(
    new Set()
  );
  const canWrite = backendCapabilities.has('plugin.write');
  const canSurface = backendCapabilities.has('plugin.surface');
  const canManagePackage = canWrite;
  const canUseLocalPluginFiles = canWrite;
  const canUseCliImport = canUseLocalPluginFiles;

  useEffect(() => {
    let active = true;
    setBackendCapabilities(new Set());
    if (!transport.capabilities) return;
    void transport
      .capabilities()
      .then((result) => {
        if (active) setBackendCapabilities(new Set(result.capabilities));
      })
      .catch(() => {
        if (active) setBackendCapabilities(new Set());
      });
    return () => {
      active = false;
    };
  }, [transport]);

  const reloadGenerationRef = useRef(0);
  const reload = useCallback(async () => {
    const generation = ++reloadGenerationRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const [next, nextContributions] = await Promise.all([
        api.catalog(),
        ecosystem === 'vibex'
          ? api.contributionCatalog().catch(() => null)
          : Promise.resolve(null),
      ]);
      if (generation !== reloadGenerationRef.current) return;
      setCatalog(next);
      setContributionCatalog(nextContributions);
      setSelectedId((current) =>
        current && next.plugins.some((plugin) => plugin.id === current)
          ? current
          : (next.plugins[0]?.id ?? null)
      );
    } catch (cause) {
      if (generation !== reloadGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === reloadGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [api, ecosystem]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visiblePlugins = useMemo(() => {
    const normalized = queries[effectiveTab].trim().toLocaleLowerCase();
    return (catalog?.plugins ?? []).filter((plugin) => {
      const matchesEcosystem = pluginEcosystem(plugin) === effectiveTab;
      const matchesQuery =
        !normalized ||
        plugin.name.toLocaleLowerCase().includes(normalized) ||
        plugin.id.toLocaleLowerCase().includes(normalized) ||
        plugin.skills.some((skill) =>
          skill.id.toLocaleLowerCase().includes(normalized)
        );
      return matchesEcosystem && matchesQuery;
    });
  }, [catalog, effectiveTab, queries]);
  const selected =
    visiblePlugins.find((plugin) => plugin.id === selectedId) ??
    visiblePlugins[0] ??
    null;
  const selectedRegistryContributions = useMemo(
    () =>
      ecosystem === 'vibex' && contributionCatalog && selected
        ? contributionCatalog.items.filter(
            (item) => item.pluginId === selected.id
          )
        : undefined,
    [contributionCatalog, ecosystem, selected]
  );

  const chooseZipImport = async (packageKind: PluginImportPackageKind) => {
    if (!canUseLocalPluginFiles) return;
    const picked = await pickHostFile({
      title: 'Select plugin package',
      extensions: ['zip', 'vxp'],
    });
    if (typeof picked !== 'string') return;
    setBusy(true);
    setError(null);
    try {
      const preview = await api.previewImport(picked, false, packageKind);
      setImportPath(picked);
      setImportPackageKind(packageKind);
      setDeveloperLink(false);
      setImportPreview(preview);
      setImportChooserOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectImportEcosystem = (ecosystem: PluginEcosystem) => {
    setImportEcosystem(ecosystem);
    setCliCommand('');
    setCliLogs([]);
    setCliImportStatus('idle');
    setCliImportResult(null);
    setCliImportError(null);
  };

  const appendCliEvent = (event: PluginCliImportEvent) => {
    setCliLogs((current) => {
      switch (event.event) {
        case 'started':
          return [...current, `$ ${event.command}`];
        case 'log':
          return [
            ...current,
            `${event.stream === 'stderr' ? '! ' : ''}${event.line}`,
          ];
        case 'command_finished':
          return [
            ...current,
            event.success
              ? t('plugins.cliCommandSucceeded')
              : t('plugins.cliCommandFailed', {
                  code: event.exitCode ?? '—',
                }),
          ];
      }
    });
  };

  const runCliImport = async () => {
    if (!canUseCliImport || importEcosystem === 'vibex' || !cliCommand.trim()) {
      return;
    }
    setCliImportStatus('running');
    setCliLogs([]);
    setCliImportResult(null);
    setCliImportError(null);
    try {
      const result = await api.importCli(
        importEcosystem,
        cliCommand,
        appendCliEvent
      );
      setCliImportResult(result);
      setCliImportStatus('succeeded');
      await reload();
    } catch (cause) {
      setCliImportError(cause instanceof Error ? cause.message : String(cause));
      setCliImportStatus('failed');
    }
  };

  const applyImport = async (decision: 'reject' | 'keep' | 'replace') => {
    if (!importPath || !canUseLocalPluginFiles) return;
    setBusy(true);
    try {
      const imported = await api.import(
        importPath,
        developerLink,
        decision,
        importPackageKind ?? undefined
      );
      setImportPreview(null);
      setImportPath(null);
      setImportPackageKind(null);
      await reload();
      setSelectedId(imported.id);
      if (!ecosystem) setActiveTab(pluginEcosystem(imported));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (plugin: PluginControlItem, enabled: boolean) => {
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    try {
      if (
        enabled &&
        !plugin.nativeManaged &&
        plugin.permissions?.some(
          (permission) => permission.trustTier === 'trusted_native'
        )
      ) {
        for (const runtime of plugin.runtimes) {
          const ready = (catalog?.runtimes ?? []).some((installed) =>
            runtimeLockIsReady(runtime, installed)
          );
          if (!ready) await api.installRuntime(plugin.id, runtime.id);
        }
      }
      const updated = await api.setEnabled(plugin.id, enabled);
      if (enabled && !plugin.nativeManaged && canWrite) {
        await api.configureAgents(plugin.id, true, []);
      }
      setCatalog((current) =>
        current
          ? {
              ...current,
              plugins: current.plugins.map((item) =>
                item.id === plugin.id ? { ...item, ...updated, enabled } : item
              ),
            }
          : current
      );
      if (
        enabled &&
        !plugin.nativeManaged &&
        (updated.mcpCount ?? plugin.mcpCount ?? 0) > 0
      ) {
        setCapabilitySetup({ ...plugin, ...updated, enabled: true });
      }
    } catch (cause) {
      const message = getInvokeErrorMessage(cause);
      setError(message);
      toast.error(
        t(enabled ? 'plugins.enableFailed' : 'plugins.disableFailed', {
          name: plugin.name,
        }),
        { description: message }
      );
    } finally {
      setBusy(false);
    }
  };

  const performUpdate = async (plugin: PluginControlItem) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.update(plugin.id);
      setCatalog((current) =>
        current
          ? {
              ...current,
              plugins: current.plugins.map((item) =>
                item.id === plugin.id ? { ...item, ...updated } : item
              ),
            }
          : current
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const updatePlugin = async (plugin: PluginControlItem) => {
    if (!canWrite) return;
    await performUpdate(plugin);
  };

  const rollbackPlugin = async (plugin: PluginControlItem) => {
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    try {
      const restored = await api.rollback(plugin.id);
      const refreshed = await api.catalog();
      setCatalog(refreshed);
      setSelectedId(restored.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const configureAllAgents = async () => {
    if (!capabilitySetup) return;
    setBusy(true);
    try {
      if ((capabilitySetup.mcpCount ?? 0) > 0) {
        await api.configureMcp(capabilitySetup.id, true, []);
      }
      setCapabilitySetup(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    if (!uninstallTarget || !canWrite) return;
    setBusy(true);
    try {
      await api.uninstall(uninstallTarget.id);
      setUninstallTarget(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const installRuntime = async (
    plugin: PluginControlItem,
    runtimeId: string
  ) => {
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    try {
      await api.installRuntime(plugin.id, runtimeId);
      await reload();
      setSelectedId(plugin.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return {
    transport,
    api,
    appSurfaceTransport,
    catalog,
    contributionCatalog,
    selectedId,
    setSelectedId,
    activeTab,
    setActiveTab,
    effectiveTab,
    queries,
    setQueries,
    isLoading,
    busy,
    error,
    importChooserOpen,
    setImportChooserOpen,
    importEcosystem,
    cliCommand,
    setCliCommand,
    cliLogs,
    cliImportStatus,
    cliImportResult,
    cliImportError,
    importPreview,
    setImportPreview,
    capabilitySetup,
    setCapabilitySetup,
    uninstallTarget,
    setUninstallTarget,
    canWrite,
    canSurface,
    canManagePackage,
    canUseLocalPluginFiles,
    canUseCliImport,
    reload,
    visiblePlugins,
    selected,
    selectedRegistryContributions,
    chooseZipImport,
    selectImportEcosystem,
    runCliImport,
    applyImport,
    setEnabled,
    updatePlugin,
    rollbackPlugin,
    configureAllAgents,
    uninstall,
    installRuntime,
  };
}
