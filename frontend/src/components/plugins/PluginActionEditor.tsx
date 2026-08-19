import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { BackendTransport } from '@/lib/backendTransport';

export type PluginPromptBlock = {
  type: 'text';
  text: string;
};

export type PluginArtifactIntent = {
  mediaTypes: string[];
  provider: string;
};

export type PluginActionDefinition = {
  pluginId: string;
  actionId: string;
  label: string;
  requiredSkills: string[];
  requiredTools: string[];
  promptBlocks: PluginPromptBlock[];
  artifactIntent?: PluginArtifactIntent | null;
};

export type PluginActionDraft = PluginActionDefinition;

export function isPluginActionDraft(
  value: unknown
): value is PluginActionDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const artifactIntent = candidate.artifactIntent;
  return (
    typeof candidate.pluginId === 'string' &&
    typeof candidate.actionId === 'string' &&
    typeof candidate.label === 'string' &&
    Array.isArray(candidate.requiredSkills) &&
    candidate.requiredSkills.every((item) => typeof item === 'string') &&
    Array.isArray(candidate.requiredTools) &&
    candidate.requiredTools.every((item) => typeof item === 'string') &&
    Array.isArray(candidate.promptBlocks) &&
    candidate.promptBlocks.every(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string'
    ) &&
    (artifactIntent === undefined ||
      artifactIntent === null ||
      (typeof artifactIntent === 'object' &&
        Array.isArray((artifactIntent as Record<string, unknown>).mediaTypes) &&
        (
          (artifactIntent as Record<string, unknown>).mediaTypes as unknown[]
        ).every((item) => typeof item === 'string') &&
        typeof (artifactIntent as Record<string, unknown>).provider ===
          'string'))
  );
}

type PluginActionCatalog = {
  actions: PluginActionDefinition[];
  readiness?: {
    enabled: boolean;
    dependency: {
      id: string;
      status: 'missing' | 'installing' | 'ready' | 'failed' | 'incompatible';
    };
    skills?: Array<{ id: string; status: string }>;
    providers?: Array<{ id: string; status: string }>;
    overall?: 'ready' | 'not_ready';
  };
};

function mapWorkflowCatalog(value: unknown): PluginActionCatalog | null {
  if (!value || typeof value !== 'object') return null;
  const workflows = (value as { workflows?: unknown }).workflows;
  if (!Array.isArray(workflows)) return null;
  return {
    actions: workflows.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const actionId = String(record.workflowId ?? record.actionId ?? '');
      const pluginId = String(record.pluginId ?? '');
      if (!actionId || !pluginId) return [];
      return [
        {
          pluginId,
          actionId,
          label: String(record.label ?? actionId),
          requiredSkills: Array.isArray(record.requiredSkills)
            ? record.requiredSkills.filter(
                (skill): skill is string => typeof skill === 'string'
              )
            : [],
          requiredTools: Array.isArray(record.requiredTools)
            ? record.requiredTools.filter(
                (tool): tool is string => typeof tool === 'string'
              )
            : [],
          promptBlocks: Array.isArray(record.promptBlocks)
            ? (record.promptBlocks as PluginPromptBlock[])
            : [{ type: 'text' as const, text: '' }],
        },
      ];
    }),
  };
}

function isPluginActionCatalog(value: unknown): value is PluginActionCatalog {
  return (
    typeof value === 'object' &&
    value !== null &&
    'actions' in value &&
    Array.isArray(value.actions)
  );
}

function artifactLabel(mediaType: string): string {
  if (mediaType.endsWith('presentationml.presentation')) return 'PPTX';
  if (mediaType.endsWith('wordprocessingml.document')) return 'DOCX';
  if (mediaType.endsWith('spreadsheetml.sheet')) return 'XLSX';
  return mediaType;
}

function ActionChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border bg-secondary/45 px-2 py-1 text-[11px] font-medium text-secondary-foreground">
      {children}
    </span>
  );
}

export function PluginActionEditor({
  transport,
  value,
  onChange,
  showPromptEditor = true,
  onReadyChange,
}: {
  transport: BackendTransport;
  value: PluginActionDraft | null;
  onChange: (value: PluginActionDraft) => void;
  showPromptEditor?: boolean;
  onReadyChange?: (ready: boolean) => void;
}) {
  const { t } = useTranslation(['tasks', 'common']);
  const [actions, setActions] = useState<PluginActionDefinition[]>([]);
  const [catalog, setCatalog] = useState<PluginActionCatalog | null>(null);
  const [isCatalogLoading, setIsCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const installAttemptRef = useRef<{
    cancelRequested: boolean;
  } | null>(null);
  const componentReadiness = Boolean(
    catalog?.readiness &&
      (catalog.readiness.skills?.every((skill) => skill.status === 'ready') ??
        true) &&
      (catalog.readiness.providers?.every(
        (provider) => provider.status === 'ready'
      ) ??
        true) &&
      (catalog.readiness.overall ? catalog.readiness.overall === 'ready' : true)
  );
  const actionReady =
    value === null ||
    (!isCatalogLoading &&
      !catalogError &&
      catalog !== null &&
      (catalog.readiness
        ? catalog.readiness.enabled &&
          catalog.readiness.dependency.status === 'ready' &&
          componentReadiness &&
          !isInstalling &&
          !installError
        : !isInstalling && !installError));

  useEffect(() => {
    onReadyChange?.(actionReady);
  }, [actionReady, onReadyChange]);

  useEffect(() => {
    let active = true;
    setIsCatalogLoading(true);
    setCatalogError(null);
    void transport
      .call('plugin_workflow_catalog')
      .catch(() => null)
      .then((catalog) => {
        const mapped = mapWorkflowCatalog(catalog);
        if (mapped) return mapped;
        return transport.call('plugin_action_catalog').then((legacy) =>
          isPluginActionCatalog(legacy) ? legacy : null
        );
      })
      .then((catalog) => {
        if (active && catalog) {
          setActions(catalog.actions);
          setCatalog(catalog);
        }
      })
      .catch((error) => {
        if (active) {
          setCatalogError(
            error instanceof Error ? error.message : String(error)
          );
        }
      })
      .finally(() => {
        if (active) {
          setIsCatalogLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [catalogReload, transport]);

  const updatePrompt = (text: string) => {
    if (!value) return;
    onChange({
      ...value,
      promptBlocks: [{ type: 'text', text }],
    });
  };

  const installDependency = async (
    action: PluginActionDefinition | null = value
  ) => {
    if (!action) return;
    if (installAttemptRef.current) return;
    const attempt = { cancelRequested: false };
    installAttemptRef.current = attempt;
    setIsInstalling(true);
    setInstallError(null);
    try {
      for (const runtimeId of action.requiredTools) {
        await transport.call('plugin_control_install_runtime', {
          pluginId: action.pluginId,
          runtimeId,
        });
      }
      const refreshedCatalog =
        (await transport.call('plugin_workflow_catalog').catch(() => null)) ??
        (await transport.call('plugin_action_catalog'));
      const mapped =
        mapWorkflowCatalog(refreshedCatalog) ??
        (isPluginActionCatalog(refreshedCatalog) ? refreshedCatalog : null);
      if (!mapped) {
        throw new Error(t('pluginActions.invalidCatalog'));
      }
      setActions(mapped.actions);
      setCatalog(mapped);
    } catch (error) {
      if (!attempt.cancelRequested) {
        setInstallError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (installAttemptRef.current === attempt) {
        installAttemptRef.current = null;
        setIsInstalling(false);
      }
    }
  };

  const cancelInstall = async () => {
    const attempt = installAttemptRef.current;
    if (!attempt) return;
    attempt.cancelRequested = true;
    setInstallError(null);
    installAttemptRef.current = null;
    setIsInstalling(false);
  };

  const selectAction = (action: PluginActionDefinition) => {
    onChange({
      ...action,
      requiredSkills: [...action.requiredSkills],
      requiredTools: [...action.requiredTools],
      promptBlocks: action.promptBlocks.map((block) => ({ ...block })),
      artifactIntent: action.artifactIntent
        ? {
            ...action.artifactIntent,
            mediaTypes: [...action.artifactIntent.mediaTypes],
          }
        : null,
    });

    if (
      catalog?.readiness &&
      (!catalog.readiness.enabled ||
        catalog.readiness.dependency.status !== 'ready')
    ) {
      void installDependency(action);
    }
  };

  return (
    <div className="space-y-3">
      {isCatalogLoading ? (
        <div
          role="status"
          aria-label={t('pluginActions.loadingAria')}
          className="text-xs text-muted-foreground"
        >
          {t('pluginActions.loading')}
        </div>
      ) : catalogError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-xs text-destructive"
        >
          <span>{catalogError}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setCatalogReload((value) => value + 1)}
          >
            {t('pluginActions.retry')}
          </Button>
        </div>
      ) : actions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('pluginActions.empty')}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={`${action.pluginId}:${action.actionId}`}
            type="button"
            size="sm"
            variant="outline"
            disabled={isInstalling}
            onClick={() => selectAction(action)}
          >
            {t(`pluginActions.actions.${action.actionId}`, {
              defaultValue: action.label,
            })}
          </Button>
        ))}
      </div>

      {isInstalling ? (
        <div
          role="status"
          aria-label={t('pluginActions.installProgressAria')}
          className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
        >
          <span>{t('pluginActions.installing')}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void cancelInstall()}
          >
            {t('pluginActions.cancelInstall')}
          </Button>
        </div>
      ) : null}

      {installError ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          <span>{installError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void installDependency()}
          >
            {t('pluginActions.retryInstall')}
          </Button>
        </div>
      ) : null}

      {value ? (
        <>
          <div
            className="flex flex-wrap gap-1.5"
            aria-label="Plugin action capabilities"
          >
            {value.requiredSkills.map((skill) => (
              <ActionChip key={`skill:${skill}`}>Skill · {skill}</ActionChip>
            ))}
            {value.requiredTools.map((tool) => (
              <ActionChip key={`tool:${tool}`}>Tool · {tool}</ActionChip>
            ))}
            {value.artifactIntent?.mediaTypes.map((mediaType) => (
              <ActionChip key={`artifact:${mediaType}`}>
                Artifact · {artifactLabel(mediaType)}
              </ActionChip>
            ))}
          </div>
          {showPromptEditor ? (
            <Textarea
              aria-label={t('pluginActions.promptAria')}
              value={value.promptBlocks.map((block) => block.text).join('\n')}
              onChange={(event) => updatePrompt(event.target.value)}
              rows={3}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
