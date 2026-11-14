import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentId, AgentPreflightView } from 'shared/types';
import {
  agentManagementApi,
  agentManagementErrorMessage,
} from '@/features/agent-management';
import { writePreflightSnapshot } from '@/pages/settings/agentPreflightSnapshot';
import type {
  OnboardingAgentCheck,
  OnboardingAgentOption,
} from './onboardingAgentModel';

export function useOnboardingAgentChecks(
  agents: OnboardingAgentOption[],
  active: boolean
) {
  const { t } = useTranslation('dialogs');
  const [checks, setChecks] = useState<Record<string, OnboardingAgentCheck>>(
    {}
  );
  const attempted = useRef(new Set<string>());
  const generations = useRef(new Map<string, number>());
  const inFlight = useRef(
    new Map<string, Promise<AgentPreflightView | undefined>>()
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const check = useCallback(
    (id: AgentId) => {
      const existing = inFlight.current.get(id);
      if (existing) return existing;
      attempted.current.add(id);
      const generation = generations.current.get(id) ?? 0;
      setChecks((current) => ({
        ...current,
        [id]: { ...current[id], checking: true, error: undefined },
      }));
      const task = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const report = await Promise.race([
            agentManagementApi.preflight(id),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(t('onboarding.checkTimedOut'))),
                30_000
              );
            }),
          ]);
          if (
            mounted.current &&
            (generations.current.get(id) ?? 0) === generation
          ) {
            setChecks((current) => ({ ...current, [id]: { report } }));
            writePreflightSnapshot(report);
          }
          return report;
        } catch (cause) {
          if (
            mounted.current &&
            (generations.current.get(id) ?? 0) === generation
          )
            setChecks((current) => ({
              ...current,
              [id]: {
                error: agentManagementErrorMessage(
                  cause,
                  t('onboarding.setupFailed')
                ),
              },
            }));
          return undefined;
        } finally {
          clearTimeout(timer);
          if ((generations.current.get(id) ?? 0) === generation)
            inFlight.current.delete(id);
        }
      })();
      inFlight.current.set(id, task);
      return task;
    },
    [t]
  );
  const installation = useCallback((id: AgentId, failed: boolean) => {
    generations.current.set(id, (generations.current.get(id) ?? 0) + 1);
    inFlight.current.delete(id);
    attempted.current.add(id);
    setChecks((current) => ({
      ...current,
      [id]: { installationFailed: failed },
    }));
  }, []);
  useEffect(() => {
    if (!active) return;
    const pending = agents.filter(
      (agent) =>
        agent.added &&
        agent.platformSupported &&
        !agent.needsInstallation &&
        !['queued', 'installing', 'repairing', 'updating'].includes(
          agent.lifecycle
        ) &&
        !attempted.current.has(agent.agentId)
    );
    let stopped = false;
    const worker = async () => {
      while (!stopped && pending.length) {
        const agent = pending.shift();
        if (agent) await check(agent.agentId);
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => {
      stopped = true;
    };
  }, [active, agents, check]);
  return { checks, check, installation };
}
