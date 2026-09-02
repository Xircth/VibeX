import { useCallback, useEffect, useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ArrowLeft, Check, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDiscoveryProgressView,
  AgentId,
  AgentOperationEvent,
  EditorConfig,
} from 'shared/types';

import { ExternalEditorPicker } from '@/components/settings/ExternalEditorPicker';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage,
} from '@/features/agent-management';
import { backendListen } from '@/lib/backendTransport';
import { APP_NAME } from '@/lib/branding';
import { settingsWindowApi, versionControlApi } from '@/lib/api';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { sortAgentsForBar } from '@/pages/settings/agentBarOrder';

import { AgentSetupPicker } from './AgentSetupPicker';
import {
  OnboardingDisclaimerDialog,
  OnboardingDisclaimerNotice,
} from './OnboardingDisclaimer';
import { VersionControlSetup } from './VersionControlSetup';
import type { AgentValidationError } from './AgentSetupPicker';
import { AgentScatter } from './hero/AgentScatter';
import { EquationLine } from './hero/EquationLine';
import { ProductStack } from './hero/ProductStack';
import {
  buildOnboardingAgentOptions,
  classifyOnboardingInstallResult,
  normalizeOnboardingAgentSelection,
  selectDefaultOnboardingAgent,
  type OnboardingAgentOption,
  type OnboardingInstallResult,
} from './onboardingAgentModel';

import './firstRunExperience.css';

gsap.registerPlugin(useGSAP);

const AGENT_LIST_TIMEOUT_MS = 4_000;

type FirstRunStep = 'intro' | 'configure' | 'welcome';

function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  return at > 0 && at < trimmed.length - 1;
}

type SetupResult = {
  agentId: AgentId;
  displayName: string;
  result: OnboardingInstallResult;
  detail?: string;
};

function optionalAgentErrorDetail(error: unknown): string | undefined {
  return agentManagementErrorMessage(error, '') || undefined;
}

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
  }) => Promise<void>;
  onFinish: () => void;
}) {
  const { t, i18n } = useTranslation(['dialogs', 'common']);
  const heroLocale = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(open);
  const [step, setStep] = useState<FirstRunStep>('intro');
  const [agents, setAgents] = useState<OnboardingAgentOption[]>([]);
  const [enabledAgentIds, setEnabledAgentIds] = useState<Set<AgentId>>(
    () => new Set()
  );
  const [defaultAgentId, setDefaultAgentId] = useState<AgentId | null>(
    initialDefaultAgentId
  );
  const [editor, setEditor] = useState<EditorConfig>(initialEditor);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [discoveryProgress, setDiscoveryProgress] =
    useState<AgentDiscoveryProgressView | null>(null);
  const [discoverySnapshotStale, setDiscoverySnapshotStale] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [gitInstalled, setGitInstalled] = useState<boolean | null>(null);
  const [gitUserName, setGitUserName] = useState('');
  const [gitUserEmail, setGitUserEmail] = useState('');
  const [versionControlError, setVersionControlError] = useState<string | null>(
    null
  );
  const [versionControlInstallFailed, setVersionControlInstallFailed] =
    useState(false);
  const [installingVersionControl, setInstallingVersionControl] =
    useState(false);
  const [validationError, setValidationError] =
    useState<AgentValidationError>(null);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const agentCheckStartedRef = useRef(false);
  const agentCatalogLoadedRef = useRef(false);
  const enabledAgentIdsRef = useRef<Set<AgentId>>(new Set());
  const defaultAgentIdRef = useRef<AgentId | null>(initialDefaultAgentId);
  const userModifiedAgentIdsRef = useRef<Set<AgentId>>(new Set());
  const agentLoadRequestRef = useRef(0);
  const agentLoadInFlightRef = useRef(false);
  const agentLoadPendingRef = useRef(false);
  const discoveryProgressRef = useRef<AgentDiscoveryProgressView | null>(null);
  const mountedRef = useRef(true);
  const handoffCompleteRef = useRef(false);
  const deferredResultsRef = useRef<SetupResult[]>([]);
  const trackedOperationsRef = useRef(
    new Map<string, { agentId: AgentId; displayName: string }>()
  );
  const expectedOperationsRef = useRef(
    new Map<AgentId, { agentId: AgentId; displayName: string }>()
  );
  const prefersReducedMotion = useMediaQuery(
    '(prefers-reduced-motion: reduce)'
  );
  const applyAgentSelection = useCallback(
    (enabledIds: Set<AgentId>, selectedDefaultId: AgentId | null) => {
      enabledAgentIdsRef.current = enabledIds;
      defaultAgentIdRef.current = selectedDefaultId;
      setEnabledAgentIds(enabledIds);
      setDefaultAgentId(selectedDefaultId);
    },
    []
  );

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
      rootRef.current?.querySelector<HTMLElement>('#onboarding-title')?.focus();
    });
  }, [step, visible]);

  const showSetupResult = useCallback(
    ({ displayName, result, detail }: SetupResult) => {
      if (result === 'verified') {
        toast.success(
          t('dialogs:onboarding.installVerified', { agent: displayName })
        );
        return;
      }

      const settingsAction = {
        label: t('dialogs:onboarding.openAgentSettings'),
        onClick: () => void settingsWindowApi.open(),
      };
      if (result === 'needs_attention') {
        toast.warning(
          t('dialogs:onboarding.installNeedsAttention', {
            agent: displayName,
          }),
          { action: settingsAction, duration: 12_000 }
        );
        return;
      }

      toast.error(
        t('dialogs:onboarding.installFailed', { agent: displayName }),
        {
          action: settingsAction,
          duration: 15_000,
          details: detail
            ? [
                {
                  title: t('dialogs:onboarding.failureDetail'),
                  description: detail,
                  mono: true,
                },
              ]
            : undefined,
        }
      );
    },
    [t]
  );

  const publishSetupResult = useCallback(
    (result: SetupResult) => {
      if (handoffCompleteRef.current) showSetupResult(result);
      else deferredResultsRef.current.push(result);
    },
    [showSetupResult]
  );

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void backendListen<AgentOperationEvent>(
      'agent-management-event',
      (event) => {
        if (!active) return;
        const expected = expectedOperationsRef.current.get(event.agent_id);
        if (expected && !trackedOperationsRef.current.has(event.operation_id)) {
          trackedOperationsRef.current.set(event.operation_id, expected);
        }
        const tracked = trackedOperationsRef.current.get(event.operation_id);
        if (!tracked) return;
        if (
          event.status !== 'succeeded' &&
          event.status !== 'failed' &&
          event.status !== 'canceled' &&
          event.status !== 'interrupted'
        ) {
          return;
        }

        trackedOperationsRef.current.delete(event.operation_id);
        expectedOperationsRef.current.delete(event.agent_id);
        if (event.status !== 'succeeded') {
          publishSetupResult({
            ...tracked,
            result: 'failed',
            detail: event.message?.trim() || undefined,
          });
          return;
        }

        void agentManagementApi
          .preflight(tracked.agentId)
          .then((report) => {
            publishSetupResult({
              ...tracked,
              result: classifyOnboardingInstallResult(
                event.status,
                report.items.map((item) => item.status)
              ),
            });
          })
          .catch((error) => {
            publishSetupResult({
              ...tracked,
              result: 'needs_attention',
              detail: optionalAgentErrorDetail(error),
            });
          });
      }
    ).then((dispose) => {
      if (active) unlisten = dispose;
      else dispose();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [publishSetupResult]);

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
    setValidationError(null);
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
      const configuredDefault = options.some(
        (agent) => agent.agentId === initialDefaultAgentId
      )
        ? initialDefaultAgentId
        : null;
      const nextEnabled = new Set(
        options
          .filter((agent) => agent.runtimeInstalled)
          .map((agent) => agent.agentId)
      );
      const nextDefault =
        configuredDefault && nextEnabled.has(configuredDefault)
          ? configuredDefault
          : (nextEnabled.values().next().value ?? null);

      setAgents(options);
      if (initialCatalogLoad) {
        applyAgentSelection(nextEnabled, nextDefault ?? null);
      } else {
        const mergedEnabled = new Set(enabledAgentIdsRef.current);
        const availableAgentIds = new Set(
          options.map((agent) => agent.agentId)
        );
        for (const agentId of mergedEnabled) {
          if (!availableAgentIds.has(agentId)) mergedEnabled.delete(agentId);
        }
        for (const agent of options) {
          if (userModifiedAgentIdsRef.current.has(agent.agentId)) continue;
          if (agent.runtimeInstalled) mergedEnabled.add(agent.agentId);
          else mergedEnabled.delete(agent.agentId);
        }
        const currentDefault = defaultAgentIdRef.current;
        const mergedDefault =
          currentDefault && mergedEnabled.has(currentDefault)
            ? currentDefault
            : (mergedEnabled.values().next().value ?? null);
        applyAgentSelection(mergedEnabled, mergedDefault);
      }
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
  }, [applyAgentSelection, initialDefaultAgentId, t]);

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
    if (!visible) return;
    let active = true;
    void versionControlApi
      .detectGit()
      .then((status) => {
        if (active) setGitInstalled(status.installed);
      })
      .catch(() => {
        if (active) setGitInstalled(false);
      });
    return () => {
      active = false;
    };
  }, [visible]);

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
        gsap.set('.onboarding-step-copy > *, .onboarding-step-actions', {
          autoAlpha: 1,
          x: 0,
          y: 0,
          scale: 1,
        });
      });
      return () => media.revert();
    },
    { scope: rootRef, dependencies: [step, visible], revertOnUpdate: true }
  );

  useEffect(() => {
    if (step !== 'welcome') return;
    const timer = window.setTimeout(
      () => {
        setVisible(false);
        handoffCompleteRef.current = true;
        deferredResultsRef.current.splice(0).forEach(showSetupResult);
        onFinish();
      },
      prefersReducedMotion ? 350 : 1_650
    );
    return () => window.clearTimeout(timer);
  }, [onFinish, prefersReducedMotion, showSetupResult, step]);

  const toggleAgent = (agentId: AgentId, enabled: boolean) => {
    const normalized = normalizeOnboardingAgentSelection({
      enabledAgentIds,
      defaultAgentId,
      changedAgentId: agentId,
      enabled,
    });
    userModifiedAgentIdsRef.current.add(agentId);
    applyAgentSelection(normalized.enabledAgentIds, normalized.defaultAgentId);
    setValidationError(null);
  };

  const selectDefault = (agentId: AgentId) => {
    const normalized = selectDefaultOnboardingAgent(enabledAgentIds, agentId);
    userModifiedAgentIdsRef.current.add(agentId);
    applyAgentSelection(normalized.enabledAgentIds, normalized.defaultAgentId);
    setValidationError(null);
  };

  const ensureVersionControlReady = async (): Promise<boolean> => {
    let installed = gitInstalled;
    if (installed === null) {
      try {
        const status = await versionControlApi.detectGit();
        installed = status.installed;
        setGitInstalled(installed);
      } catch {
        installed = false;
        setGitInstalled(false);
      }
    }
    if (installed) return true;

    const name = gitUserName.trim();
    const email = gitUserEmail.trim();
    if (!name || !email) {
      setVersionControlError(t('dialogs:onboarding.gitIdentityRequired'));
      return false;
    }
    if (!looksLikeEmail(email)) {
      setVersionControlError(t('dialogs:onboarding.gitEmailInvalid'));
      return false;
    }

    setInstallingVersionControl(true);
    setVersionControlError(null);
    try {
      const result = await versionControlApi.installTools({
        user_name: name,
        user_email: email,
      });
      if (result.error || !result.git.installed) {
        setVersionControlInstallFailed(true);
        setVersionControlError(
          result.error || t('dialogs:onboarding.versionControlInstallFailed')
        );
        return false;
      }
      setVersionControlInstallFailed(false);
      setGitInstalled(true);
      return true;
    } catch (error) {
      setVersionControlInstallFailed(true);
      setVersionControlError(
        error instanceof Error
          ? error.message
          : t('dialogs:onboarding.versionControlInstallFailed')
      );
      return false;
    } finally {
      setInstallingVersionControl(false);
    }
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
      setVisible(false);
      handoffCompleteRef.current = true;
      onFinish();
    } catch (error) {
      setSubmitError(
        agentManagementErrorMessage(error, t('dialogs:onboarding.setupFailed'))
      );
      setSubmitting(false);
    }
  };

  const handleStartSetup = async () => {
    if (submitting || !editorValid) return;
    if (enabledAgentIds.size === 0) {
      setValidationError('enabled-required');
      return;
    }
    if (!defaultAgentId) {
      setValidationError('default-required');
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    setSubmitError(null);
    setVersionControlError(null);
    try {
      if (!(await ensureVersionControlReady())) {
        setSubmitting(false);
        return;
      }

      await Promise.all(
        agents
          .filter(
            (agent) =>
              agent.added &&
              agent.enabled !== enabledAgentIds.has(agent.agentId)
          )
          .map((agent) =>
            agentManagementApi.setEnabled(
              agent.agentId,
              enabledAgentIds.has(agent.agentId)
            )
          )
      );

      const memberships = await agentManagementApi.bar();
      const ordered = sortAgentsForBar(
        memberships.map((agent) => ({
          ...agent,
          enabled: enabledAgentIds.has(agent.agent_id),
        })),
        defaultAgentId
      ).map((agent) => agent.agent_id);
      if (ordered.length > 0) {
        await agentManagementApi.reorder(ordered);
      }

      await onPersist({
        editor,
        defaultAgentId,
        skipped: false,
      });

      const selectedAgents = agents.filter((agent) =>
        enabledAgentIds.has(agent.agentId)
      );
      if (selectedAgents.some((agent) => agent.needsInstallation)) {
        try {
          const registryView = await agentManagementApi.registry();
          if (!registryView.fresh) {
            await agentManagementApi.refreshRegistry();
          }
        } catch {
          // Registry 快照不可用时继续：addAndInstall 会返回明确错误，由安装失败提示呈现。
        }
      }
      selectedAgents.forEach((agent) => {
        if (!agent.needsInstallation) {
          void agentManagementApi
            .preflight(agent.agentId)
            .then((report) => {
              publishSetupResult({
                agentId: agent.agentId,
                displayName: agent.displayName,
                result: classifyOnboardingInstallResult(
                  'succeeded',
                  report.items.map((item) => item.status)
                ),
              });
            })
            .catch((error) => {
              publishSetupResult({
                agentId: agent.agentId,
                displayName: agent.displayName,
                result: 'needs_attention',
                detail: optionalAgentErrorDetail(error),
              });
            });
          return;
        }

        expectedOperationsRef.current.set(agent.agentId, {
          agentId: agent.agentId,
          displayName: agent.displayName,
        });
        void agentManagementApi
          .addAndInstall(agent.agentId)
          .then((receipt) => {
            trackedOperationsRef.current.set(receipt.operation_id, {
              agentId: agent.agentId,
              displayName: agent.displayName,
            });
          })
          .catch((error) => {
            expectedOperationsRef.current.delete(agent.agentId);
            publishSetupResult({
              agentId: agent.agentId,
              displayName: agent.displayName,
              result: 'failed',
              detail: optionalAgentErrorDetail(error),
            });
          });
      });
      setStep('welcome');
    } catch (error) {
      setSubmitError(
        agentManagementErrorMessage(error, t('dialogs:onboarding.setupFailed'))
      );
      setSubmitting(false);
    }
  };

  const editorValid =
    editor.editor_type !== 'CUSTOM' || Boolean(editor.custom_command?.trim());

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      className="legacy-design onboarding-experience"
      data-step={step}
    >
      <div
        className="onboarding-hero-glow"
        data-testid="onboarding-hero-glow"
        aria-hidden="true"
      />

      {step === 'intro' ? (
        <main className="onboarding-intro-step">
          <AgentScatter />
          <div className="onboarding-intro-hero">
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
          <ProductStack />
          {submitError ? (
            <p className="onboarding-inline-error" role="alert">
              {submitError}
            </p>
          ) : null}
        </main>
      ) : null}

      {step === 'configure' ? (
        <main className="onboarding-config-step">
          <div className="onboarding-config-grid" inert={disclaimerOpen}>
            <section className="onboarding-config-section">
              <h2
                id="onboarding-title"
                className="onboarding-config-section-title"
                tabIndex={-1}
              >
                {t('dialogs:onboarding.agentsTitle')}
              </h2>
              <div className="onboarding-config-panel onboarding-agent-panel">
                <AgentSetupPicker
                  agents={agents}
                  enabledAgentIds={enabledAgentIds}
                  defaultAgentId={defaultAgentId}
                  loading={
                    !loadError &&
                    (loadingAgents ||
                      discoverySnapshotStale ||
                      discoveryProgress == null ||
                      discoveryProgress.phase === 'pending' ||
                      discoveryProgress.phase === 'checking')
                  }
                  discoveryProgress={discoveryProgress}
                  error={loadError}
                  validationError={validationError}
                  onRetry={() => void loadAgents()}
                  onEnabledChange={toggleAgent}
                  onDefaultChange={selectDefault}
                />
                <p className="onboarding-login-note">
                  <ShieldAlert aria-hidden="true" />
                  {t('dialogs:onboarding.loginNotice')}
                </p>
              </div>
            </section>

            <section className="onboarding-config-section">
              <h2 className="onboarding-config-section-title">
                {t('dialogs:onboarding.editorTitle')}
              </h2>
              <div className="onboarding-config-panel onboarding-editor-panel">
                <ExternalEditorPicker
                  value={editor}
                  onChange={setEditor}
                  compact
                  selectTriggerClassName="onboarding-editor-select"
                  selectContentClassName="onboarding-popover-layer onboarding-editor-options !z-[13000]"
                />
              </div>
            </section>

            {gitInstalled === false ? (
              <section className="onboarding-config-section">
                <h2 className="onboarding-config-section-title">
                  {t('dialogs:onboarding.versionControlTitle')}
                </h2>
                <p className="onboarding-version-control-copy">
                  {t('dialogs:onboarding.versionControlDescription')}
                </p>
                <VersionControlSetup
                  userName={gitUserName}
                  userEmail={gitUserEmail}
                  installing={installingVersionControl}
                  error={versionControlError}
                  disabled={submitting}
                  onUserNameChange={(value) => {
                    setGitUserName(value);
                    setVersionControlError(null);
                  }}
                  onUserEmailChange={(value) => {
                    setGitUserEmail(value);
                    setVersionControlError(null);
                  }}
                />
              </section>
            ) : null}
          </div>

          <footer className="onboarding-config-footer" inert={disclaimerOpen}>
            <OnboardingDisclaimerNotice
              onOpen={() => setDisclaimerOpen(true)}
            />
            {submitError ? (
              <p className="onboarding-inline-error" role="alert">
                {submitError}
              </p>
            ) : null}
            <div className="onboarding-step-actions onboarding-config-actions">
              <button
                type="button"
                className="onboarding-back-button"
                disabled={submitting}
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
                disabled={submitting || !editorValid}
                onClick={() => void handleStartSetup()}
              >
                {installingVersionControl
                  ? t('dialogs:onboarding.installingVersionControl')
                  : submitting
                    ? t('dialogs:onboarding.startingInstall')
                    : versionControlInstallFailed
                      ? t('dialogs:onboarding.retryVersionControl')
                      : t('dialogs:onboarding.startJourney')}
              </button>
            </div>
          </footer>
          <OnboardingDisclaimerDialog
            open={disclaimerOpen}
            onClose={() => setDisclaimerOpen(false)}
          />
        </main>
      ) : null}

      {step === 'welcome' ? (
        <main className="onboarding-welcome-step">
          <div className="onboarding-welcome-mark" aria-hidden="true">
            <Check />
          </div>
          <div className="onboarding-step-copy onboarding-welcome-copy">
            <span className="onboarding-step-count">03 / 03</span>
            <h1 id="onboarding-title" tabIndex={-1}>
              {t('dialogs:onboarding.welcomeTitle', { appName: APP_NAME })}
            </h1>
            <p>{t('dialogs:onboarding.welcomeDescription')}</p>
          </div>
        </main>
      ) : null}
    </div>
  );
}
