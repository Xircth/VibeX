import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useUserSystem } from '@/components/ConfigProvider';
import { useAgentManagement } from '@/features/agent-management';
import { isEnabledInstalledAgent } from '@/features/agents/operationalAgent';
import { listenToConversationEvents } from '@/features/conversation/events';
import { useLayoutStore } from '@/stores/useLayoutStore';
import type { ConversationRowOpBatch } from 'shared/types';

import {
  isAcpConnectorAvailable,
  isAgentLoggedIn,
  isAgentOperationallyAvailable,
} from './agentStatusPresentation';
import { BasicGuideContext } from './BasicGuideContext';
import {
  BASIC_GUIDE_OPEN_AGENT_STATUS_EVENT,
  BASIC_GUIDE_SESSION_AGENT_EVENT,
  SUBSTEP_META,
  type BasicGuideSubstep,
  type PersistedBasicGuide,
  advanceGuide,
  completeGuide,
  completeStep1,
  completeStep2,
  dismissEndCopy,
  clickAdvancesSubstep,
  isConfigureSessionSubstep,
  isProjectRoute,
  isSettingsAgentsRoute,
  isSettingsRoute,
  nextSubstep,
  restartBasicGuide,
  resolveLaunchState,
  sessionCreateHrefLooksOpen,
  shouldCompleteStep1OnRoute,
  shouldForceWelcome,
  skipBasicGuide,
  startBasicGuide,
} from './basicGuideState';
import {
  readBasicGuide,
  subscribeBasicGuide,
  writeBasicGuide,
} from './basicGuideStorage';

function hasAvailableAgent(
  agents: Array<{ enabled: boolean; lifecycle: string }>
): boolean {
  return agents.some((agent) =>
    isAgentOperationallyAvailable({
      enabled: agent.enabled,
      lifecycle: agent.lifecycle as never,
    })
  );
}

function clickedGuideTarget(
  event: Event,
  ids: readonly string[]
): HTMLElement | null {
  const path = event.composedPath();
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    const id = node.dataset.basicGuide;
    if (id && ids.includes(id)) return node;
  }
  return null;
}

export function BasicGuideProvider({ children }: { children: ReactNode }) {
  const { config } = useUserSystem();
  const location = useLocation();
  const navigate = useNavigate();
  const { state: agentState } = useAgentManagement();
  const [state, setState] = useState<PersistedBasicGuide>(() =>
    resolveLaunchState({
      raw:
        typeof window === 'undefined'
          ? null
          : window.localStorage.getItem('vibex:basic-guide'),
      onboardingAcknowledged: Boolean(config?.onboarding_acknowledged),
    })
  );
  const [exitOpen, setExitOpen] = useState(false);
  const openedAgentStatusRef = useRef(false);
  const clickedSessionsRef = useRef(new Set<string>());
  const sawCreateFormRef = useRef(false);
  const previousPathRef = useRef(location.pathname);
  const stateRef = useRef(state);
  stateRef.current = state;

  const persist = useCallback((next: PersistedBasicGuide) => {
    stateRef.current = next;
    setState(next);
    writeBasicGuide(next);
  }, []);

  useEffect(() => {
    return subscribeBasicGuide((next) => {
      if (!next) return;
      stateRef.current = next;
      setState(next);
    });
  }, []);

  useEffect(() => {
    if (readBasicGuide()) return;
    const next = resolveLaunchState({
      raw: null,
      onboardingAcknowledged: Boolean(config?.onboarding_acknowledged),
    });
    if (next.phase === 'completed') persist(next);
  }, [config?.onboarding_acknowledged, persist]);

  const goNext = useCallback(
    (from: BasicGuideSubstep) => {
      const current = stateRef.current;
      if (current.phase !== 'active' || current.substep !== from) return;
      if (from === 'select-project') return;
      if (from === 'send-hello') {
        persist(completeStep2(current));
        return;
      }
      const next = nextSubstep(from);
      if (!next) {
        persist(current);
        return;
      }
      persist(advanceGuide(current, next));
    },
    [persist]
  );

  const available = useMemo(
    () => hasAvailableAgent(agentState.agents),
    [agentState.agents]
  );

  useEffect(() => {
    // Completing step 1 lands on a project URL while reachedStep is still 0.
    // Bounce only when that URL was restored or restarted, not entered from welcome.
    if (
      shouldCompleteStep1OnRoute(
        stateRef.current,
        previousPathRef.current,
        location.pathname
      )
    ) {
      return;
    }
    if (shouldForceWelcome(state, location.pathname)) {
      navigate('/local-projects', { replace: true });
    }
  }, [location.pathname, navigate, state]);

  useEffect(() => {
    const previousPathname = previousPathRef.current;
    previousPathRef.current = location.pathname;
    const current = stateRef.current;
    if (
      !shouldCompleteStep1OnRoute(current, previousPathname, location.pathname)
    ) {
      return;
    }
    useLayoutStore.getState().setActiveTab('workspace');
    persist(completeStep1(current, available));
  }, [available, location.pathname, persist]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    if (current.reachedStep < 1) return;
    if (openedAgentStatusRef.current) return;
    if (!isProjectRoute(location.pathname)) return;
    openedAgentStatusRef.current = true;
    window.dispatchEvent(new Event(BASIC_GUIDE_OPEN_AGENT_STATUS_EVENT));
  }, [location.pathname, state.reachedStep, state.phase]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    if (current.substep !== 'need-agent') return;
    if (isSettingsAgentsRoute(location.pathname)) {
      goNext('need-agent');
    }
  }, [goNext, location.pathname]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    if (current.substep !== 'return-main') return;
    if (!isSettingsRoute(location.pathname)) {
      persist(advanceGuide(current, 'click-new-session'));
    }
  }, [location.pathname, persist]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    if (
      current.substep === 'click-new-session' &&
      sessionCreateHrefLooksOpen(location.search)
    ) {
      sawCreateFormRef.current = true;
      goNext('click-new-session');
    }
  }, [goNext, location.search]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    if (!isConfigureSessionSubstep(current.substep)) return;
    if (sessionCreateHrefLooksOpen(location.search)) {
      sawCreateFormRef.current = true;
      return;
    }
    if (!sawCreateFormRef.current) return;

    const tryAdvance = () => {
      if (!isConfigureSessionSubstep(stateRef.current.substep)) return;
      if (sessionCreateHrefLooksOpen(window.location.search)) return;
      if (document.querySelector('[data-basic-guide="session-composer"]')) {
        persist(advanceGuide(stateRef.current, 'send-hello'));
      }
    };
    tryAdvance();
    const observer = new MutationObserver(tryAdvance);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [location.pathname, location.search, persist, state.substep]);

  useEffect(() => {
    const onAgentPicked = () => {
      const current = stateRef.current;
      if (current.phase !== 'active') return;
      if (current.substep !== 'configure-session-agent') return;
      goNext('configure-session-agent');
    };
    window.addEventListener(BASIC_GUIDE_SESSION_AGENT_EVENT, onAgentPicked);
    return () => {
      window.removeEventListener(
        BASIC_GUIDE_SESSION_AGENT_EVENT,
        onAgentPicked
      );
    };
  }, [goNext]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    if (current.substep !== 'kanban-click-sessions') return;
    const monitor = document.querySelector(
      '[data-basic-guide="kanban-monitor"]'
    );
    const count = Number(monitor?.getAttribute('data-monitor-count') ?? '0');
    if (count > 0) goNext('kanban-click-sessions');
  }, [goNext, location.pathname, state.substep]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    if (
      current.substep !== 'settings-agent-enable' &&
      current.substep !== 'settings-agent-acp' &&
      current.substep !== 'settings-agent-auth' &&
      current.substep !== 'need-agent' &&
      current.substep !== 'settings-agent-icon'
    ) {
      return;
    }
    const selected =
      agentState.agents.find(
        (agent) => agent.agent_id === agentState.selectedAgentId
      ) ?? agentState.agents.find(isEnabledInstalledAgent);

    if (current.substep === 'need-agent' && available) {
      persist(advanceGuide(current, 'return-main'));
      return;
    }
    if (current.substep === 'settings-agent-enable' && selected?.enabled) {
      if (!isAcpConnectorAvailable(selected)) {
        persist(advanceGuide(current, 'settings-agent-acp'));
        return;
      }
      if (!isAgentLoggedIn(selected.authentication)) {
        persist(advanceGuide(current, 'settings-agent-auth'));
        return;
      }
      persist(advanceGuide(current, 'return-main'));
      return;
    }
    if (
      current.substep === 'settings-agent-acp' &&
      selected &&
      isAcpConnectorAvailable(selected)
    ) {
      if (!isAgentLoggedIn(selected.authentication)) {
        persist(advanceGuide(current, 'settings-agent-auth'));
        return;
      }
      persist(advanceGuide(current, 'return-main'));
      return;
    }
    if (
      current.substep === 'settings-agent-auth' &&
      selected &&
      isAgentLoggedIn(selected.authentication)
    ) {
      persist(advanceGuide(current, 'return-main'));
    }
    if (
      (current.substep === 'settings-agent-icon' ||
        current.substep === 'settings-agent-enable' ||
        current.substep === 'settings-agent-acp' ||
        current.substep === 'settings-agent-auth') &&
      available
    ) {
      persist(advanceGuide(current, 'return-main'));
    }
  }, [
    agentState.agents,
    agentState.selectedAgentId,
    available,
    persist,
    state.substep,
  ]);

  useEffect(() => {
    if (state.phase !== 'active' || state.substep !== 'send-hello') return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listenToConversationEvents((batch: ConversationRowOpBatch) => {
      if (disposed) return;
      const started = batch.ops.some((op) => op.op === 'append_text');
      if (started) goNext('send-hello');
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [goNext, state.phase, state.substep]);

  useEffect(() => {
    if (state.phase !== 'active') return;
    const meta = SUBSTEP_META[state.substep];
    if (meta.advance !== 'click' && state.substep !== 'kanban-click-sessions') {
      return;
    }
    const onClick = (event: Event) => {
      const current = stateRef.current;
      if (current.phase !== 'active') return;
      const ids = SUBSTEP_META[current.substep].targets;
      const target = clickedGuideTarget(event, ids);
      if (!target) return;
      const targetId = target.dataset.basicGuide;
      if (!targetId || !clickAdvancesSubstep(current.substep, targetId)) {
        return;
      }
      if (current.substep === 'click-new-session') {
        sawCreateFormRef.current = true;
      }
      if (current.substep === 'kanban-click-sessions') {
        const sessionId = target.dataset.sessionId;
        if (!sessionId) return;
        clickedSessionsRef.current.add(sessionId);
        if (clickedSessionsRef.current.size >= 2) {
          goNext('kanban-click-sessions');
        }
        return;
      }
      goNext(current.substep);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [goNext, state.phase, state.substep]);

  const continueStep = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    if (current.substep === 'return-main') {
      if (isSettingsRoute(location.pathname)) {
        persist(advanceGuide(current, 'click-new-session'));
        return;
      }
    }
    goNext(current.substep);
  }, [goNext, location.pathname, persist]);

  const requestExit = useCallback(() => setExitOpen(true), []);
  const cancelExit = useCallback(() => setExitOpen(false), []);
  const confirmExit = useCallback(() => {
    setExitOpen(false);
    persist(completeGuide(stateRef.current, 'exited'));
  }, [persist]);
  const finish = useCallback(() => {
    persist(completeGuide(stateRef.current, 'finished'));
  }, [persist]);
  const restart = useCallback(() => {
    openedAgentStatusRef.current = false;
    clickedSessionsRef.current = new Set();
    sawCreateFormRef.current = false;
    persist(restartBasicGuide());
    if (!isSettingsRoute(location.pathname)) {
      navigate('/local-projects', { replace: true });
    }
  }, [location.pathname, navigate, persist]);
  const dismissEnd = useCallback(() => {
    persist(dismissEndCopy(stateRef.current));
  }, [persist]);
  const start = useCallback(() => {
    persist(startBasicGuide(stateRef.current));
  }, [persist]);
  const skip = useCallback(() => {
    persist(skipBasicGuide());
  }, [persist]);

  useEffect(() => {
    if (state.endCopy === 'none') return;
    const timer = window.setTimeout(() => {
      persist(dismissEndCopy(stateRef.current));
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [persist, state.endCopy]);

  const value = useMemo(
    () => ({
      state,
      continueStep,
      requestExit,
      confirmExit,
      cancelExit,
      finish,
      restart,
      start,
      skip,
      dismissEnd,
      exitOpen,
    }),
    [
      cancelExit,
      confirmExit,
      continueStep,
      dismissEnd,
      exitOpen,
      finish,
      requestExit,
      restart,
      skip,
      start,
      state,
    ]
  );

  return (
    <BasicGuideContext.Provider value={value}>
      {children}
    </BasicGuideContext.Provider>
  );
}
