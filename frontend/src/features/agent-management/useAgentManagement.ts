import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentId,
  AgentManagementView,
  AgentOperationEvent,
  AgentRegistryViewRow,
} from 'shared/types';

import { backendListen } from '@/lib/backendTransport';
import { toast } from '@/components/ui/toast';

import { agentManagementApi } from './api';
import {
  createAgentManagementState,
  mergeManagementSnapshot,
  optimisticAddRegistryAgent,
  reduceOperationEvent,
} from './agentManagementStore';

export function useAgentManagement() {
  const [state, setState] = useState(() => createAgentManagementState([]));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const lastEventSequence = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const agents = await agentManagementApi.bar();
      setState((current) => mergeManagementSnapshot(current, agents));
      setError(null);
      return agents;
    } catch (nextError) {
      setError(nextError);
      throw nextError;
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshFresh = useCallback(async () => {
    setLoading(true);
    try {
      const agents = await agentManagementApi.refreshBar();
      setState((current) => mergeManagementSnapshot(current, agents));
      setError(null);
      return agents;
    } catch (nextError) {
      setError(nextError);
      throw nextError;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void backendListen<AgentOperationEvent>(
      'agent-management-event',
      (event) => {
        if (!active) return;
        if (event.sequence <= lastEventSequence.current) return;
        lastEventSequence.current = event.sequence;
        if (event.status === 'failed') {
          toast.error(event.message?.trim() || 'Agent 安装或验证失败');
        }
        setState((current) => reduceOperationEvent(current, event));
        if (
          event.status === 'succeeded' ||
          event.status === 'failed' ||
          event.status === 'canceled'
        ) {
          void refresh().catch(() => undefined);
        }
      }
    ).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const dispose = await backendListen<void>(
          'agent-management-snapshot-invalidated',
          () => {
            if (active) void refresh().catch(() => undefined);
          }
        );
        if (active) unlisten = dispose;
        else dispose();
      } finally {
        // Register first so a startup warmup cannot complete between the
        // initial snapshot read and invalidation subscription.
        if (active) void refresh().catch(() => undefined);
      }
    })().catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [refresh]);

  const select = useCallback((agentId: AgentId | null) => {
    setState((current) => ({ ...current, selectedAgentId: agentId }));
  }, []);

  const addAndInstall = useCallback(async (row: AgentRegistryViewRow) => {
    setState((current) => optimisticAddRegistryAgent(current, row));
    try {
      await agentManagementApi.addAndInstall(row.agent_id);
    } catch (nextError) {
      await agentManagementApi
        .bar()
        .then((agents) =>
          setState((current) => mergeManagementSnapshot(current, agents))
        )
        .catch(() => undefined);
      throw nextError;
    }
  }, []);

  const mergeAgent = useCallback((updated: AgentManagementView) => {
    setState((current) => ({
      ...current,
      agents: current.agents.map((agent) =>
        agent.agent_id === updated.agent_id ? updated : agent
      ),
    }));
  }, []);

  const selectedAgent = useMemo(
    () =>
      state.agents.find((agent) => agent.agent_id === state.selectedAgentId) ??
      null,
    [state.agents, state.selectedAgentId]
  );

  return {
    state,
    selectedAgent,
    loading,
    error,
    refresh,
    refreshFresh,
    select,
    addAndInstall,
    mergeAgent,
  };
}
