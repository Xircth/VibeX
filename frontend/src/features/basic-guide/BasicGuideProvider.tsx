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
import { useLayoutStore } from '@/stores/useLayoutStore';

import { BasicGuideContext } from './BasicGuideContext';
import {
  SUBSTEP_META,
  type BasicGuideSubstep,
  type PersistedBasicGuide,
  advanceGuide,
  completeGuide,
  completeStep1,
  dismissEndCopy,
  clickAdvancesSubstep,
  isElementInertOrHidden,
  isSettingsRoute,
  nextSubstep,
  reconcileLaunchStateForConfig,
  restartBasicGuide,
  resolveLaunchState,
  shouldCompleteStep1OnRoute,
  shouldRedirectToGuideWelcome,
  skipBasicGuide,
  startBasicGuide,
} from './basicGuideState';
import {
  readBasicGuide,
  subscribeBasicGuide,
  writeBasicGuide,
} from './basicGuideStorage';

function clickedGuideTarget(
  event: Event,
  ids: readonly string[]
): HTMLElement | null {
  const path = event.composedPath();
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    if (isElementInertOrHidden(node)) continue;
    const id = node.dataset.basicGuide;
    if (id && ids.includes(id)) return node;
  }
  return null;
}

export function BasicGuideProvider({ children }: { children: ReactNode }) {
  const { config, loading } = useUserSystem();
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<PersistedBasicGuide>(() =>
    resolveLaunchState({
      raw:
        typeof window === 'undefined'
          ? null
          : window.localStorage.getItem('dimo:basic-guide'),
      onboardingAcknowledged: Boolean(config?.onboarding_acknowledged),
    })
  );
  const [exitOpen, setExitOpen] = useState(false);
  const previousPathRef = useRef(location.pathname);
  const skippedInSessionRef = useRef(false);
  const reconciledUnacknowledgedRef = useRef(false);
  const configRef = useRef(config);
  const loadingRef = useRef(loading);
  const stateRef = useRef(state);
  configRef.current = config;
  loadingRef.current = loading;
  stateRef.current = state;

  const persist = useCallback((next: PersistedBasicGuide) => {
    stateRef.current = next;
    setState(next);
    writeBasicGuide(next);
  }, []);

  useEffect(() => {
    return subscribeBasicGuide((next, source) => {
      if (!next) return;
      if (source === 'storage') {
        const reconciled = reconcileLaunchStateForConfig({
          state: next,
          hasPersistedGuide: true,
          onboardingAcknowledged: Boolean(
            configRef.current?.onboarding_acknowledged
          ),
          configLoading: loadingRef.current || !configRef.current,
          skippedInSession: skippedInSessionRef.current,
        });
        if (reconciled) {
          persist(reconciled);
          return;
        }
      }
      stateRef.current = next;
      setState(next);
    });
  }, [persist]);

  useEffect(() => {
    if (loading || !config) return;
    if (config.onboarding_acknowledged) {
      reconciledUnacknowledgedRef.current = false;
      const reconciled = reconcileLaunchStateForConfig({
        state: stateRef.current,
        hasPersistedGuide: Boolean(readBasicGuide()),
        onboardingAcknowledged: true,
        configLoading: false,
      });
      if (reconciled) {
        persist(reconciled);
      }
      return;
    }
    if (reconciledUnacknowledgedRef.current) return;
    reconciledUnacknowledgedRef.current = true;
    const reconciled = reconcileLaunchStateForConfig({
      state: stateRef.current,
      hasPersistedGuide: Boolean(readBasicGuide()),
      onboardingAcknowledged: false,
      configLoading: false,
      skippedInSession: skippedInSessionRef.current,
    });
    if (reconciled) {
      persist(reconciled);
    }
  }, [config, loading, persist]);

  const goNext = useCallback(
    (from: BasicGuideSubstep) => {
      const current = stateRef.current;
      if (current.phase !== 'active' || current.substep !== from) return;
      if (from === 'select-project') return;
      const next = nextSubstep(from);
      if (!next) {
        persist(completeGuide(current, 'finished'));
        return;
      }
      persist(advanceGuide(current, next));
    },
    [persist]
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
    if (shouldRedirectToGuideWelcome(state, location.pathname, loading)) {
      navigate('/local-projects', { replace: true });
    }
  }, [loading, location.pathname, navigate, state]);

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
    persist(completeStep1(current));
  }, [location.pathname, persist]);

  useEffect(() => {
    if (state.phase !== 'active') return;
    const meta = SUBSTEP_META[state.substep];
    if (meta.advance !== 'click') return;
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
      goNext(current.substep);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [goNext, state.phase, state.substep]);

  const continueStep = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== 'active') return;
    goNext(current.substep);
  }, [goNext]);

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
    skippedInSessionRef.current = false;
    persist(restartBasicGuide());
    if (!isSettingsRoute(location.pathname)) {
      navigate('/local-projects', { replace: true });
    }
  }, [location.pathname, navigate, persist]);
  const dismissEnd = useCallback(() => {
    persist(dismissEndCopy(stateRef.current));
  }, [persist]);
  const start = useCallback(
    (hasSelectedProject = false) => {
      const current = stateRef.current;
      if (current.phase === 'completed' && current.endCopy === 'none') return;
      const started = startBasicGuide(current);
      if (hasSelectedProject && started.phase === 'active') {
        useLayoutStore.getState().setActiveTab('workspace');
        persist(completeStep1(started));
        return;
      }
      persist(started);
    },
    [persist]
  );
  const skip = useCallback(() => {
    skippedInSessionRef.current = true;
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
