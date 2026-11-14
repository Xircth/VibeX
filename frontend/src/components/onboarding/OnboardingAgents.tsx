import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type {
  AgentId,
  AgentRegistryView,
  AgentRegistryViewRow,
  UserAgentDefinitionRequest,
} from 'shared/types';
import { Button } from '@/components/ui/button';
import {
  agentManagementApi,
  agentManagementErrorMessage,
  useAgentManagement,
} from '@/features/agent-management';
import { AgentRegistryViewPanel } from '@/pages/settings/AgentRegistryView';
import { OnboardingAgentDetail } from './OnboardingAgentDetail';
import { AgentSetupPicker } from './AgentSetupPicker';
import type { ComponentProps, ReactNode } from 'react';

export function OnboardingAgents({
  picker,
  onDirtyChange,
  editor,
}: {
  picker: ComponentProps<typeof AgentSetupPicker>;
  onDirtyChange: (dirty: boolean) => void;
  editor: ReactNode;
}) {
  const { t } = useTranslation('dialogs');
  const management = useAgentManagement();
  const [inspectedId, setInspectedId] = useState<AgentId | null>(null);
  const [dirty, setDirty] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registry, setRegistry] = useState<AgentRegistryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registryRef = useRef<HTMLElement>(null);
  const installing = useRef(new Set<string>());
  useEffect(() => {
    if (registryOpen && window.matchMedia('(max-width: 760px)').matches)
      registryRef.current?.focus();
  }, [registryOpen]);
  const dirtyChange = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirtyChange(value);
    },
    [onDirtyChange]
  );
  const inspect = (id: AgentId | null) => {
    if (dirty) {
      setError(t('onboarding.unsavedConfiguration'));
      return;
    }
    setError(null);
    setInspectedId(id);
    setRegistryOpen(false);
  };
  const loadRegistry = async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setRegistry(
        await (fresh
          ? agentManagementApi.refreshRegistry()
          : agentManagementApi.registry())
      );
    } catch (cause) {
      setError(agentManagementErrorMessage(cause, t('onboarding.setupFailed')));
    } finally {
      setLoading(false);
    }
  };
  const add = async (
    input: AgentRegistryViewRow | UserAgentDefinitionRequest
  ) => {
    setAdding(input.agent_id);
    setError(null);
    try {
      if ('display_name' in input && 'registry_id' in input)
        await management.addAndInstall(input);
      else
        management.beginOperation(
          await agentManagementApi.addUserDefinitionAndInstall(input)
        );
      picker.onEnabledChange(input.agent_id, true);
      setRegistryOpen(false);
      setInspectedId(input.agent_id);
      await management.refresh();
      picker.onRetry();
    } catch (cause) {
      setError(agentManagementErrorMessage(cause, t('onboarding.setupFailed')));
    } finally {
      setAdding(null);
    }
  };
  const agent = management.state.agents.find(
    (item) => item.agent_id === inspectedId
  );
  const rows = picker.agents
    .filter((item) => item.builtIn || item.added)
    .map((item) => {
      const view = management.state.agents.find(
        (candidate) => candidate.agent_id === item.agentId
      );
      return view
        ? {
            ...item,
            lifecycle: view.lifecycle,
            platformSupported:
              view.lifecycle !== 'platform_unsupported' &&
              item.platformSupported,
          }
        : item;
    });
  return (
    <div
      className={
        inspectedId || registryOpen
          ? 'onboarding-agents-layout has-detail'
          : 'onboarding-agents-layout'
      }
    >
      <section className="onboarding-agents-list-pane">
        <AgentSetupPicker
          {...picker}
          agents={rows}
          onInspect={inspect}
          inspectedAgentId={inspectedId}
          onEnabledChange={(id, enabled) => {
            picker.onEnabledChange(id, enabled);
            if (!enabled) return;
            const option = rows.find((item) => item.agentId === id);
            const view = management.state.agents.find(
              (item) => item.agent_id === id
            );
            if (
              !option?.needsInstallation ||
              view?.active_operation ||
              installing.current.has(id)
            )
              return;
            installing.current.add(id);
            void (async () => {
              try {
                management.beginOperation(
                  await agentManagementApi.addAndInstall(id)
                );
                picker.onRetry();
              } catch (cause) {
                setError(
                  agentManagementErrorMessage(
                    cause,
                    t('onboarding.setupFailed')
                  )
                );
              } finally {
                installing.current.delete(id);
              }
            })();
          }}
        />
        <button
          type="button"
          className="onboarding-registry-entry"
          onClick={() => {
            if (dirty) {
              setError(t('onboarding.unsavedConfiguration'));
              return;
            }
            setRegistryOpen(true);
            setInspectedId(null);
            void loadRegistry();
          }}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span>{t('onboarding.registryImport')}</span>
        </button>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {editor}
      </section>
      {registryOpen ? (
        <aside
          className="onboarding-agent-detail settings-page"
          tabIndex={-1}
          ref={registryRef}
        >
          <Button
            className="self-end"
            size="icon"
            variant="ghost"
            aria-label={t('onboarding.closeDetail')}
            onClick={() => setRegistryOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
          <AgentRegistryViewPanel
            view={registry}
            loading={loading}
            addingAgentId={adding}
            onRefresh={() => void loadRegistry(true)}
            onAdd={(row) => void add(row)}
            onAddUserDefinition={(request) => void add(request)}
          />
        </aside>
      ) : agent ? (
        <OnboardingAgentDetail
          key={agent.agent_id}
          agent={agent}
          operation={management.state.operations[agent.agent_id]}
          onRefresh={management.refresh}
          onDirtyChange={dirtyChange}
          onClose={() => inspect(null)}
          onInstall={async () => {
            management.beginOperation(
              await (agent.lifecycle === 'needs_repair'
                ? agentManagementApi.repair(agent.agent_id)
                : agentManagementApi.addAndInstall(agent.agent_id))
            );
            picker.onRetry();
          }}
        />
      ) : null}
    </div>
  );
}
