import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentManagementView,
  AgentOperationEvent,
  AgentOperationReceipt,
  AgentRegistryViewRow,
} from 'shared/types';

import { backendListen } from '@/lib/backendTransport';
import { toast } from '@/components/ui/toast';

import { agentManagementApi } from './api';
import {
  beginQueuedOperation,
  createAgentManagementState,
  mergeManagementSnapshot,
  optimisticAddRegistryAgent,
  reduceOperationEvent,
} from './agentManagementStore';

let retainedSelectedAgentId: string | null = null;

export function useAgentManagement() {
  const { t, i18n } = useTranslation('settings');
  const [state, setState] = useState(() => {
    const initial = createAgentManagementState([]);
    return retainedSelectedAgentId
      ? { ...initial, selectedAgentId: retainedSelectedAgentId }
      : initial;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const lastEventSequence = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const agents = await agentManagementApi.bar();
      setState((current) => {
        const next = mergeManagementSnapshot(current, agents);
        retainedSelectedAgentId = next.selectedAgentId;
        return next;
      });
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
      setState((current) => {
        const next = mergeManagementSnapshot(current, agents);
        retainedSelectedAgentId = next.selectedAgentId;
        return next;
      });
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
        const next = coerceOperationEvent(event);
        if (!next) return;
        if (next.sequence <= lastEventSequence.current) return;
        lastEventSequence.current = next.sequence;
        if (next.status === 'failed') {
          const message = next.message?.trim();
          toast.error(
            i18n.resolvedLanguage?.startsWith('en')
              ? t('agents.operationFailed')
              : message || t('agents.operationFailed')
          );
        }
        setState((current) => reduceOperationEvent(current, next));
        if (
          next.status === 'succeeded' ||
          next.status === 'failed' ||
          next.status === 'canceled'
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
  }, [i18n.resolvedLanguage, refresh, t]);

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
    retainedSelectedAgentId = agentId;
    setState((current) => ({ ...current, selectedAgentId: agentId }));
  }, []);

  const beginOperation = useCallback((receipt: AgentOperationReceipt) => {
    setState((current) => beginQueuedOperation(current, receipt));
  }, []);

  const addAndInstall = useCallback(async (row: AgentRegistryViewRow) => {
    setState((current) => optimisticAddRegistryAgent(current, row));
    try {
      const receipt = await agentManagementApi.addAndInstall(row.agent_id);
      setState((current) => beginQueuedOperation(current, receipt));
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
    beginOperation,
    mergeAgent,
  };
}

function coerceOperationEvent(
  raw: AgentOperationEvent | Record<string, unknown> | null | undefined
): AgentOperationEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const nested = record.payload;
  const source =
    nested &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    ('operation_id' in nested ||
      'operationId' in nested ||
      'agent_id' in nested ||
      'agentId' in nested)
      ? (nested as Record<string, unknown>)
      : record;
  const operationId = String(source.operation_id ?? source.operationId ?? '');
  const agentId = String(source.agent_id ?? source.agentId ?? '');
  if (!operationId || !agentId) return null;
  const sequence = Number(source.sequence);
  if (!Number.isFinite(sequence)) return null;
  return {
    sequence,
    agent_id: agentId as AgentOperationEvent['agent_id'],
    operation_id: operationId,
    kind: source.kind as AgentOperationEvent['kind'],
    status: source.status as AgentOperationEvent['status'],
    progress_percent:
      typeof source.progress_percent === 'number'
        ? source.progress_percent
        : typeof source.progressPercent === 'number'
          ? source.progressPercent
          : null,
    message:
      typeof source.message === 'string'
        ? source.message
        : source.message == null
          ? null
          : String(source.message),
  };
}
