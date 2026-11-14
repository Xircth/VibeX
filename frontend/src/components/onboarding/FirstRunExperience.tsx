import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ThemeMode,
  type AgentDiscoveryProgressView,
  type AgentId,
  type EditorConfig,
} from 'shared/types';

import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  agentManagementApi,
  agentManagementErrorMessage,
  useAgentManagement,
} from '@/features/agent-management';
import { agentsApi } from '@/features/agents/api';
import { backendListen } from '@/lib/backendTransport';

import { OnboardingAgents } from './OnboardingAgents';
import { OnboardingAccount } from './OnboardingAccount';
import { useVibeXAccount } from '@/features/model-router/useVibeXAccount';
import { useAccountDeviceLogin } from '@/pages/settings/useAccountDeviceLogin';
import { OnboardingHistoryImport } from './OnboardingHistoryImport';
import { OnboardingProjects } from './OnboardingProjects';
import { OnboardingAppearance } from './OnboardingAppearance';
import {
  OnboardingDisclaimerDialog,
  OnboardingDisclaimerNotice,
} from './OnboardingDisclaimer';
import { useOnboardingAgentChecks } from './useOnboardingAgentChecks';
import { AgentScatter } from './hero/AgentScatter';
import { EquationLine } from './hero/EquationLine';
import {
  buildOnboardingAgentOptions,
  onboardingAgentStatus,
  canJoinOnboardingRoster,
  type OnboardingAgentOption,
} from './onboardingAgentModel';
import {
  LocalAgentDetectedDialog,
  findLocallyDetectedAgents,
  type LocalDetectedAgent,
} from './LocalAgentDetectedDialog';

import './firstRunExperience.css';

gsap.registerPlugin(useGSAP);

const AGENT_LIST_TIMEOUT_MS = 4_000;

type FirstRunStep = 'intro' | 'configure' | 'history' | 'projects' | 'appearance';

function rejectAfter<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(message)),
      timeoutMs
    );
    promise.then(resolve, reject).finally(() => window.clearTimeout(timeout));
  });
}

export function FirstRunExperience({
  open,
  initialEditor,
  initialDefaultAgentId,
  onPersist,
  onFinish,
}: {
  open: boolean;
  initialEditor: EditorConfig;
  initialDefaultAgentId: AgentId;
  onPersist: (result: {
    editor: EditorConfig;
    defaultAgentId: AgentId;
    skipped: boolean;
    theme?: ThemeMode;
  }) => Promise<void>;
  onFinish: (projectIds?: string[]) => Promise<void> | void;
}) {
  const { t, i18n } = useTranslation(['dialogs', 'common']);
  const heroLocale = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(open);
  const [step, setStep] = useState<FirstRunStep>('intro');
  const [projectSetupStarted, setProjectSetupStarted] = useState(false);
  const [historySources, setHistorySources] = useState<AgentId[] | null>(null);
  const [importedProjectIds, setImportedProjectIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [agents, setAgents] = useState<OnboardingAgentOption[]>([]);
  const [enabledAgentIds, setEnabledAgentIds] = useState<Set<AgentId>>(
    () => new Set()
  );
  const management = useAgentManagement();
  const editor = initialEditor;
  const [failedNotice, setFailedNotice] = useState<string[] | null>(null);
  const [pendingRoster, setPendingRoster] = useState<AgentId[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] =
    useState<AgentDiscoveryProgressView | null>(null);
  const [discoverySnapshotStale, setDiscoverySnapshotStale] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const agentCheckStartedRef = useRef(false);
  const agentCatalogLoadedRef = useRef(false);
  const enabledAgentIdsRef = useRef<Set<AgentId>>(new Set());
  const userModifiedAgentIdsRef = useRef<Set<AgentId>>(new Set());
  const userReorderedRosterRef = useRef(false);
  const agentLoadRequestRef = useRef(0);
  const agentLoadInFlightRef = useRef(false);
  const agentLoadPendingRef = useRef(false);
  const discoveryProgressRef = useRef<AgentDiscoveryProgressView | null>(null);
  const mountedRef = useRef(true);
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const [localAgentDialogOpen, setLocalAgentDialogOpen] = useState(false);
  const [localAgentDialogDismissed, setLocalAgentDialogDismissed] =
    useState(false);
  const [detectedLocalAgents, setDetectedLocalAgents] = useState<
    LocalDetectedAgent[]
  >([]);
  const [pendingAutoEnableIds, setPendingAutoEnableIds] = useState<AgentId[]>(
    []
  );
  const consumeAutoEnableIds = useCallback(() => {
    setPendingAutoEnableIds([]);
  }, []);
  const allowAutoRosterForAgent = useCallback((id: AgentId) => {
    userModifiedAgentIdsRef.current.delete(id);
  }, []);
  const account = useVibeXAccount();
  const accountLogin = useAccountDeviceLogin(account);
  const applyAgentSelection = useCallback((enabledIds: Set<AgentId>) => {
    enabledAgentIdsRef.current = enabledIds;
    setEnabledAgentIds(enabledIds);
  }, []);

  useEffect(() => {
    if (open) setVisible(true);
  }, [open]);

  useEffect(() => {
    if (!visible || !rootRef.current) return;
    const root = rootRef.current;
    const parent = root.parentElement;
    const siblings = parent
      ? [...parent.children].filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== root
        )
      : [];
    const previous = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    const previousOverflow = document.body.style.overflow;
    siblings.forEach((element) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });
    document.body.style.overflow = 'hidden';

    return () => {
      previous.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      document.body.style.overflow = previousOverflow;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    window.requestAnimationFrame(() => {
      [
        ...(rootRef.current?.querySelectorAll<HTMLElement>(
          '#onboarding-title'
        ) ?? []),
      ]
        .find((title) => !title.closest('[hidden]'))
        ?.focus();
    });
  }, [step, visible]);

  const loadAgents = useCallback(async () => {
    // Startup invalidation events may arrive while the initial snapshot is
    // still loading. Keep that request single-flight so those events cannot
    // continually replace its timeout and leave the skeleton visible forever.
    if (agentLoadInFlightRef.current) {
      agentLoadPendingRef.current = true;
      return;
    }
    agentLoadInFlightRef.current = true;
    agentLoadPendingRef.current = false;
    const requestId = ++agentLoadRequestRef.current;
    const initialCatalogLoad = !agentCatalogLoadedRef.current;
    if (initialCatalogLoad) setLoadingAgents(true);
    if (initialCatalogLoad) setLoadError(null);
    try {
      const managedAgents = await rejectAfter(
        agentManagementApi.bar(),
        AGENT_LIST_TIMEOUT_MS,
        t('dialogs:onboarding.agentLoadTimedOut')
      );
      if (!mountedRef.current || agentLoadRequestRef.current !== requestId)
        return;
      if (managedAgents.length === 0) {
        throw new Error(t('dialogs:onboarding.agentCatalogEmpty'));
      }
      const options = buildOnboardingAgentOptions(managedAgents, []);
      setAgents(options);
      agentCatalogLoadedRef.current = true;

      void agentManagementApi
        .registry()
        .then((registry) => {
          if (!mountedRef.current || agentLoadRequestRef.current !== requestId)
            return;
          setAgents(
            buildOnboardingAgentOptions(managedAgents, [
              ...registry.installed,
              ...registry.uninstalled,
            ])
          );

          if (!registry.fresh) {
            void agentManagementApi
              .refreshRegistry()
              .then((refreshed) => {
                if (
                  !mountedRef.current ||
                  agentLoadRequestRef.current !== requestId
                )
                  return;
                setAgents(
                  buildOnboardingAgentOptions(managedAgents, [
                    ...refreshed.installed,
                    ...refreshed.uninstalled,
                  ])
                );
              })
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    } catch (error) {
      if (
        mountedRef.current &&
        initialCatalogLoad &&
        agentLoadRequestRef.current === requestId
      ) {
        setLoadError(
          error instanceof Error
            ? error.message
            : t('dialogs:onboarding.agentLoadFailed')
        );
      }
    } finally {
      agentLoadInFlightRef.current = false;
      if (
        mountedRef.current &&
        initialCatalogLoad &&
        agentLoadRequestRef.current === requestId
      ) {
        setLoadingAgents(false);
      }
      if (mountedRef.current && agentLoadPendingRef.current) {
        agentLoadPendingRef.current = false;
        void loadAgents();
      } else {
        const progress = discoveryProgressRef.current;
        if (
          mountedRef.current &&
          agentLoadRequestRef.current === requestId &&
          progress &&
          progress.phase !== 'pending' &&
          progress.phase !== 'checking'
        ) {
          setDiscoverySnapshotStale(false);
        }
      }
    }
  }, [t]);

  useEffect(() => {
    // StrictMode performs a development-only setup/cleanup/setup cycle while
    // preserving refs. Restoring this flag during setup keeps the real startup
    // request valid; a genuine unmount still prevents late state updates.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!visible || agentCheckStartedRef.current) return;
    agentCheckStartedRef.current = true;
    void loadAgents();
  }, [loadAgents, visible]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void backendListen<AgentDiscoveryProgressView>(
      'agent-management-discovery-progress',
      (progress) => {
        if (!active) return;
        if (progress.phase === 'pending' || progress.phase === 'checking') {
          setDiscoverySnapshotStale(true);
        }
        setDiscoveryProgress(progress);
      }
    ).then(async (dispose) => {
      if (!active) {
        dispose();
        return;
      }
      unlisten = dispose;
      try {
        const progress = await agentManagementApi.discoveryProgress();
        if (!active) return;
        if (progress.phase === 'pending' || progress.phase === 'checking') {
          setDiscoverySnapshotStale(true);
        }
        setDiscoveryProgress(progress);
      } catch {
        if (active) {
          setDiscoveryProgress({
            phase: 'complete',
            completed: 0,
            total: 0,
            found: 0,
            checked_agent_ids: [],
            timed_out: false,
          });
        }
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  discoveryProgressRef.current = discoveryProgress;

  useEffect(() => {
    if (
      !visible ||
      !discoverySnapshotStale ||
      discoveryProgress == null ||
      discoveryProgress.phase === 'pending' ||
      discoveryProgress.phase === 'checking'
    ) {
      return;
    }
    void loadAgents();
  }, [discoveryProgress, discoverySnapshotStale, loadAgents, visible]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void backendListen<void>('agent-management-snapshot-invalidated', () => {
      if (active && visible && agentCheckStartedRef.current) void loadAgents();
    }).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [loadAgents, visible]);

  useGSAP(
    () => {
      if (!visible) return;
      const copy = '.onboarding-step-copy > *, .onboarding-step-actions';
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        if (step !== 'intro') return;
        gsap
          .timeline({ defaults: { ease: 'power3.out' } })
          .fromTo(
            '.onboarding-step-copy > *',
            { autoAlpha: 0, y: 24 },
            { autoAlpha: 1, y: 0, duration: 0.7, stagger: 0.08 }
          )
          .fromTo(
            '.onboarding-step-actions',
            { autoAlpha: 0, y: 14 },
            { autoAlpha: 1, y: 0, duration: 0.45 },
            '-=0.32'
          );
      });
      media.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(copy, {
          autoAlpha: 1,
          x: 0,
          y: 0,
          scale: 1,
        });
      });
      // Some Windows WebView2 builds match neither query. Never leave the
      // guide copy at autoAlpha 0 waiting for an animation that will not run.
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
      const allow = window.matchMedia(
        '(prefers-reduced-motion: no-preference)'
      );
      if (!reduce.matches && !allow.matches) {
        gsap.set(copy, { autoAlpha: 1, x: 0, y: 0, scale: 1 });
      }
      return () => media.revert();
    },
    { scope: rootRef, dependencies: [step, visible], revertOnUpdate: true }
  );

  const displayAgents = useMemo(
    () =>
      agents.map((option) => {
        const view = management.state.agents.find(
          (item) => item.agent_id === option.agentId
        );
        const operation = management.state.operations[option.agentId];
        const acpReady = view
          ? Boolean(
              view.acp_version ||
                ['ready', 'needs_auth', 'needs_config'].includes(view.lifecycle)
            )
          : !option.needsInstallation;
        const localDetected = view
          ? Boolean(
              view.local_runtime?.path ||
                view.desktop_client?.path ||
                option.localDetected
            )
          : option.localDetected;
        const updated = view
          ? {
              ...option,
              added: true,
              enabled: view.enabled,
              lifecycle: view.lifecycle,
              localDetected,
              runtimeInstalled: acpReady || Boolean(localDetected),
              needsInstallation: !acpReady,
              platformSupported:
                view.lifecycle !== 'platform_unsupported' &&
                option.platformSupported,
            }
          : option;
        if (
          operation &&
          ['queued', 'running', 'canceling'].includes(operation.status)
        )
          return { ...updated, lifecycle: 'installing' as const };
        return updated;
      }),
    [agents, management.state.agents, management.state.operations]
  );
  const health = useOnboardingAgentChecks(displayAgents, step === 'configure');
  useEffect(() => {
    const pendingDialogIds = new Set(
      localAgentDialogOpen
        ? detectedLocalAgents.map((agent) => agent.agentId)
        : []
    );
    const eligible = new Set(
      displayAgents
        .filter(
          (agent) =>
            !pendingDialogIds.has(agent.agentId) &&
            (canJoinOnboardingRoster(
              onboardingAgentStatus(agent, health.checks[agent.agentId])
            ) ||
              (onboardingAgentStatus(agent, health.checks[agent.agentId]) ===
                'checking' &&
                enabledAgentIdsRef.current.has(agent.agentId)))
        )
        .map((agent) => agent.agentId)
    );
    const next = new Set(
      [...enabledAgentIdsRef.current].filter((id) => eligible.has(id))
    );
    for (const id of eligible)
      if (!userModifiedAgentIdsRef.current.has(id)) next.add(id);
    const ordered = userReorderedRosterRef.current
      ? next
      : new Set(
          [
            initialDefaultAgentId,
            ...displayAgents.map((agent) => agent.agentId),
          ].filter((id) => next.has(id))
        );
    if ([...ordered].join('|') !== [...enabledAgentIdsRef.current].join('|'))
      applyAgentSelection(ordered);
  }, [
    displayAgents,
    health.checks,
    initialDefaultAgentId,
    applyAgentSelection,
    localAgentDialogOpen,
    detectedLocalAgents,
  ]);
  const changeRoster = (ids: AgentId[]) => {
    userReorderedRosterRef.current = true;
    for (const id of enabledAgentIdsRef.current)
      if (!ids.includes(id)) userModifiedAgentIdsRef.current.add(id);
    for (const id of ids) userModifiedAgentIdsRef.current.delete(id);
    applyAgentSelection(new Set(ids));
  };

  /**
   * Show the local-agent-detected dialog once after discovery completes and
   * the agent catalog is loaded. Snapshot the detected list so background
   * state updates never mutate or empty the open dialog.
   */
  useEffect(() => {
    if (
      step !== 'configure' ||
      localAgentDialogDismissed ||
      localAgentDialogOpen
    )
      return;
    if (loadingAgents || !agentCatalogLoadedRef.current) return;
    if (
      discoverySnapshotStale ||
      discoveryProgress == null ||
      discoveryProgress.phase === 'pending' ||
      discoveryProgress.phase === 'checking'
    )
      return;
    const detected = findLocallyDetectedAgents(
      displayAgents,
      enabledAgentIdsRef.current
    );
    if (detected.length > 0) {
      setDetectedLocalAgents(detected);
      setLocalAgentDialogOpen(true);
    }
  }, [
    step,
    loadingAgents,
    displayAgents,
    discoveryProgress,
    discoverySnapshotStale,
    localAgentDialogDismissed,
    localAgentDialogOpen,
  ]);

  const handleLocalAgentConfirm = (ids: AgentId[]) => {
    const selectedSet = new Set(ids);
    for (const agent of detectedLocalAgents) {
      if (selectedSet.has(agent.agentId))
        userModifiedAgentIdsRef.current.delete(agent.agentId);
      else userModifiedAgentIdsRef.current.add(agent.agentId);
    }
    const kept = new Set(
      [...enabledAgentIdsRef.current].filter(
        (id) =>
          !detectedLocalAgents.some((agent) => agent.agentId === id) ||
          selectedSet.has(id)
      )
    );
    applyAgentSelection(kept);
    setLocalAgentDialogOpen(false);
    setLocalAgentDialogDismissed(true);
    if (ids.length > 0) setPendingAutoEnableIds(ids);
  };

  const handleLocalAgentSkip = () => {
    for (const agent of detectedLocalAgents) {
      userModifiedAgentIdsRef.current.add(agent.agentId);
    }
    const kept = new Set(
      [...enabledAgentIdsRef.current].filter(
        (id) => !detectedLocalAgents.some((agent) => agent.agentId === id)
      )
    );
    applyAgentSelection(kept);
    setLocalAgentDialogOpen(false);
    setLocalAgentDialogDismissed(true);
  };

  const handleSkip = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onPersist({
        editor: initialEditor,
        defaultAgentId: initialDefaultAgentId,
        skipped: true,
      });
      await onFinish([]);
      setVisible(false);
    } catch (error) {
      setSubmitError(
        agentManagementErrorMessage(error, t('dialogs:onboarding.setupFailed'))
      );
      setSubmitting(false);
    }
  };

  /**
   * Local history folders are a pre-check for the optional import step. A failed
   * check is not "no history": open the history step so its retry stays visible.
   */
  const discoverHistorySources = useCallback(async (): Promise<
    AgentId[] | null
  > => {
    try {
      return await agentsApi.discoverLocalHistorySources();
    } catch {
      return null;
    }
  }, []);

  const persistSetup = async (ids: AgentId[]) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const memberships = await agentManagementApi.bar();
      const changes = await Promise.allSettled(
        memberships
          .filter((agent) => agent.enabled !== ids.includes(agent.agent_id))
          .map((agent) =>
            agentManagementApi.setEnabled(
              agent.agent_id,
              ids.includes(agent.agent_id)
            )
          )
      );
      const errors = changes.filter((result) => result.status === 'rejected');
      if (errors.length)
        throw new Error(
          errors
            .map((result) =>
              agentManagementErrorMessage(
                result.reason,
                t('dialogs:onboarding.setupFailed')
              )
            )
            .join('; ')
        );
      const ordered = [
        ...ids,
        ...memberships
          .map((agent) => agent.agent_id)
          .filter((id) => !ids.includes(id)),
      ];
      if (ordered.length) await agentManagementApi.reorder(ordered);
      await onPersist({
        editor,
        defaultAgentId: ids[0] ?? initialDefaultAgentId,
        skipped: false,
      });
      setFailedNotice(null);
      setProjectSetupStarted(true);
      const sources = await discoverHistorySources();
      if (sources?.length) {
        setHistorySources(sources);
        setStep('history');
      } else if (sources) {
        setHistorySources([]);
        setStep('projects');
      } else {
        setHistorySources(null);
        setStep('history');
      }
    } catch (error) {
      setFailedNotice(null);
      setSubmitError(
        agentManagementErrorMessage(error, t('dialogs:onboarding.setupFailed'))
      );
    } finally {
      setSubmitting(false);
    }
  };
  const handleStartSetup = async () => {
    if (submitting || configurationDirty) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const ids = [...enabledAgentIds];
      const reports = await Promise.all(ids.map((id) => health.check(id)));
      const current = await agentManagementApi.bar();
      const options = buildOnboardingAgentOptions(current, []);
      const eligible = ids.filter((id, index) => {
        const option = options.find((agent) => agent.agentId === id);
        return (
          option &&
          canJoinOnboardingRoster(
            onboardingAgentStatus(option, { report: reports[index] })
          )
        );
      });
      if (eligible.length !== ids.length) {
        throw new Error(t('dialogs:onboarding.rosterCheckFailed'));
      }
      const failed = options
        .filter(
          (agent) =>
            onboardingAgentStatus(agent, health.checks[agent.agentId]) ===
            'install_failed'
        )
        .map((agent) => agent.displayName);
      if (failed.length) {
        setPendingRoster(eligible);
        setFailedNotice(failed);
      } else await persistSetup(eligible);
    } catch (error) {
      setSubmitError(
        agentManagementErrorMessage(error, t('dialogs:onboarding.setupFailed'))
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      className="legacy-design onboarding-experience"
      data-step={step}
    >
      <div
        data-tauri-drag-region
        className="window-chrome onboarding-window-chrome"
      />

      {step === 'intro' ? (
        <main className="onboarding-intro-step">
          <AgentScatter />
          <div className="onboarding-intro-hero">
            <Logo
              showText={false}
              size="hero"
              className="onboarding-welcome-logo"
            />
            <div className="onboarding-step-copy onboarding-intro-copy">
              <h1
                id="onboarding-title"
                tabIndex={-1}
                aria-label={t('dialogs:onboarding.journeyTitle')}
              >
                <span>{t('dialogs:onboarding.journeyTitleA')}</span>
                <span>{t('dialogs:onboarding.journeyTitleB')}</span>
              </h1>
              <p>{t('dialogs:onboarding.journeyDescription')}</p>
              <EquationLine locale={heroLocale} />
            </div>

            <OnboardingAccount account={account} login={accountLogin} />
            <div className="onboarding-step-actions onboarding-intro-actions">
              <button
                type="button"
                className="onboarding-skip-button"
                disabled={submitting}
                onClick={() => void handleSkip()}
              >
                {t('dialogs:onboarding.skip')}
              </button>
              <button
                type="button"
                className="onboarding-primary-button"
                onClick={() => setStep('configure')}
              >
                {t('dialogs:onboarding.next')}
              </button>
            </div>
          </div>
          {submitError ? (
            <p className="onboarding-inline-error" role="alert">
              {submitError}
            </p>
          ) : null}
        </main>
      ) : null}

      {step === 'configure' ? (
        <main className="onboarding-config-step">
          <nav
            className="onboarding-journey"
            aria-label={t('dialogs:onboarding.stepsLabel')}
            inert={
              disclaimerOpen ||
              failedNotice !== null ||
              localAgentDialogOpen ||
              submitting
            }
          >
            <button
              type="button"
              disabled={submitting || configurationDirty}
              onClick={() => setStep('intro')}
            >
              {t('dialogs:onboarding.welcomeStep')}
            </button>
            <ChevronRight aria-hidden="true" />
            <span id="onboarding-title" tabIndex={-1} aria-current="step">
              {t('dialogs:onboarding.agentStep')}
            </span>
            <ChevronRight aria-hidden="true" />
            <span>{t('dialogs:onboarding.historyStep')}</span>
            <ChevronRight aria-hidden="true" />
            <span>{t('dialogs:onboarding.projectStep')}</span>
            <ChevronRight aria-hidden="true" />
            <span>{t('dialogs:onboarding.appearanceStep')}</span>
          </nav>
          <p className="onboarding-configure-description">
            {t('dialogs:onboarding.agentStepDescription')}
          </p>
          <div
            className="onboarding-config-body"
            inert={
              disclaimerOpen ||
              failedNotice !== null ||
              localAgentDialogOpen ||
              submitting
            }
          >
            <OnboardingAgents
              management={management}
              health={health}
              rosterIds={[...enabledAgentIds]}
              onRosterChange={changeRoster}
              onDirtyChange={setConfigurationDirty}
              pendingAutoEnableIds={pendingAutoEnableIds}
              onConsumeAutoEnableIds={consumeAutoEnableIds}
              onWillInstallAgent={allowAutoRosterForAgent}
              picker={{
                agents: displayAgents,
                checks: health.checks,
                loading: !loadError && loadingAgents,
                discoveryProgress,
                error: loadError,
                onRetry: () => void loadAgents(),
              }}
            />
          </div>

          <footer
            className="onboarding-config-footer"
            inert={
              disclaimerOpen ||
              failedNotice !== null ||
              localAgentDialogOpen ||
              submitting
            }
          >
            <OnboardingDisclaimerNotice
              onOpen={() => setDisclaimerOpen(true)}
            />
            {submitError ? (
              <p className="onboarding-inline-error" role="alert">
                {submitError}
              </p>
            ) : null}
            {configurationDirty ? (
              <p className="text-xs text-muted-foreground" role="status">
                {t('dialogs:onboarding.unsavedConfiguration')}
              </p>
            ) : null}
            <div className="onboarding-step-actions onboarding-config-actions">
              <button
                type="button"
                className="onboarding-back-button"
                disabled={
                  submitting ||
                  configurationDirty ||
                  pendingAutoEnableIds.length > 0
                }
                onClick={() => {
                  setDisclaimerOpen(false);
                  setStep('intro');
                }}
              >
                <ArrowLeft aria-hidden="true" />
                {t('dialogs:onboarding.back')}
              </button>
              <button
                type="button"
                className="onboarding-primary-button"
                disabled={
                  submitting ||
                  configurationDirty ||
                  pendingAutoEnableIds.length > 0 ||
                  displayAgents.some(
                    (agent) =>
                      onboardingAgentStatus(
                        agent,
                        health.checks[agent.agentId]
                      ) === 'installing' ||
                      onboardingAgentStatus(
                        agent,
                        health.checks[agent.agentId]
                      ) === 'checking'
                  )
                }
                onClick={() => void handleStartSetup()}
              >
                {t('dialogs:onboarding.next')}
              </button>
            </div>
          </footer>
          <Dialog
            open={failedNotice !== null}
            uncloseable
            className="onboarding-popover-layer"
            aria-describedby="onboarding-failed-agents-description"
          >
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>
                  {t('dialogs:onboarding.failedAgentsTitle')}
                </DialogTitle>
              </DialogHeader>
              <p id="onboarding-failed-agents-description">
                {t('dialogs:onboarding.failedAgentsDescription')}
              </p>
              <ul>
                {failedNotice?.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <DialogFooter>
                <Button
                  autoFocus
                  disabled={submitting}
                  onClick={() => void persistSetup(pendingRoster)}
                >
                  {t('dialogs:onboarding.acknowledge')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <OnboardingDisclaimerDialog
            open={disclaimerOpen}
            onClose={() => setDisclaimerOpen(false)}
          />
          <LocalAgentDetectedDialog
            open={localAgentDialogOpen}
            detected={detectedLocalAgents}
            onClose={handleLocalAgentSkip}
            onConfirm={handleLocalAgentConfirm}
          />
        </main>
      ) : null}

      {projectSetupStarted ? (
        <div hidden={step !== 'history'} inert={step !== 'history'}>
          <OnboardingHistoryImport
            sourceAgents={displayAgents}
            active={step === 'history'}
            onBack={() => setStep('configure')}
            onFinish={async (ids) => {
              setImportedProjectIds(ids);
              setStep('projects');
            }}
          />
        </div>
      ) : null}
      {projectSetupStarted ? (
        <div hidden={step !== 'projects'} inert={step !== 'projects'}>
          <OnboardingProjects
            initialProjectIds={importedProjectIds}
            active={step === 'projects'}
            onBack={() =>
              setStep(
                historySources && historySources.length ? 'history' : 'configure'
              )
            }
            onFinish={async (ids) => {
              setProjectIds(ids);
              setStep('appearance');
            }}
          />
        </div>
      ) : null}
      {step === 'appearance' ? (
        <OnboardingAppearance
          onBack={() => setStep('projects')}
          onNavigateStep={(target) => {
            if (
              target === 'history' &&
              (!historySources || !historySources.length)
            ) {
              setStep('configure');
              return;
            }
            setStep(target);
          }}
          onContinue={async (theme) => {
            await onPersist({
              editor,
              defaultAgentId: [...enabledAgentIds][0] ?? initialDefaultAgentId,
              skipped: false,
              theme,
            });
            await onFinish(projectIds);
            setVisible(false);
          }}
        />
      ) : null}
    </div>
  );
}
