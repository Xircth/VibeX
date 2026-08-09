import { useCallback, useEffect, useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ArrowLeft, Check, ShieldAlert, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentManagementView,
  AgentOperationEvent,
  AgentRegistryViewRow,
  EditorConfig,
} from 'shared/types';

import { ExternalEditorPicker } from '@/components/settings/ExternalEditorPicker';
import { toast } from '@/components/ui/toast';
import { PortalContainerContext } from '@/contexts/PortalContainerContext';
import { agentManagementApi } from '@/features/agent-management';
import { backendListen } from '@/lib/backendTransport';
import { APP_NAME } from '@/lib/branding';
import { settingsWindowApi } from '@/lib/api';
import { useMediaQuery } from '@/hooks/useMediaQuery';

import { AgentSetupPicker } from './AgentSetupPicker';
import type { AgentValidationError } from './AgentSetupPicker';
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

type FirstRunStep = 'intro' | 'configure' | 'welcome';

type SetupResult = {
  agentId: AgentId;
  displayName: string;
  result: OnboardingInstallResult;
  detail?: string;
};

type IntroAgent = {
  id: string;
  label: string;
  light?: string;
  dark?: string;
  monogram?: string;
};

const INTRO_AGENTS: IntroAgent[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    light: '/agents/claude-light.svg',
    dark: '/agents/claude-dark.svg',
  },
  {
    id: 'codex',
    label: 'Codex',
    light: '/agents/codex-light.svg',
    dark: '/agents/codex-dark.svg',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    light: '/agents/cursor-light.svg',
    dark: '/agents/cursor-dark.svg',
  },
  { id: 'pi', label: 'Pi', light: '/agents/pi.svg' },
  { id: 'kimi', label: 'Kimi Code', monogram: 'K' },
  {
    id: 'opencode',
    label: 'OpenCode',
    light: '/agents/opencode-light.svg',
    dark: '/agents/opencode-dark.svg',
  },
];

function IntroAgentIcon({ agent }: { agent: IntroAgent }) {
  if (agent.monogram) {
    return (
      <span className="onboarding-intro-monogram" aria-hidden="true">
        {agent.monogram}
      </span>
    );
  }

  const light = agent.light ?? agent.dark ?? '';
  const dark = agent.dark ?? agent.light ?? '';
  return (
    <picture aria-hidden="true">
      <source media="(prefers-color-scheme: dark)" srcSet={dark} />
      <img alt="" src={light} />
    </picture>
  );
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
  const { t } = useTranslation(['dialogs', 'common']);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null
  );
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] =
    useState<AgentValidationError>(null);
  const agentCheckStartedRef = useRef(false);
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
  const captureRoot = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element;
    if (element) setPortalContainer(element);
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
              detail: error instanceof Error ? error.message : String(error),
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
    setLoadingAgents(true);
    setLoadError(null);
    setValidationError(null);
    try {
      const [managedResult, registryResult] = await Promise.allSettled([
        agentManagementApi.bar(),
        agentManagementApi.registry(),
      ]);
      if (managedResult.status === 'rejected') throw managedResult.reason;

      const managedAgents: AgentManagementView[] = managedResult.value;
      let registryAgents: AgentRegistryViewRow[] = [];
      if (registryResult.status === 'fulfilled') {
        let registry = registryResult.value;
        if (!registry.fresh) {
          registry = await agentManagementApi
            .refreshRegistry()
            .catch(() => registry);
        }
        registryAgents = [...registry.installed, ...registry.uninstalled];
      }

      const options = buildOnboardingAgentOptions(
        managedAgents,
        registryAgents
      );
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
      setEnabledAgentIds(nextEnabled);
      setDefaultAgentId(nextDefault ?? null);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : t('dialogs:onboarding.agentLoadFailed')
      );
    } finally {
      setLoadingAgents(false);
    }
  }, [initialDefaultAgentId, t]);

  useEffect(() => {
    if (!visible || agentCheckStartedRef.current) return;
    agentCheckStartedRef.current = true;
    void loadAgents();
  }, [loadAgents, visible]);

  useGSAP(
    () => {
      if (!visible) return;
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
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

        gsap.to('.onboarding-aurora', {
          backgroundPosition: '100% 50%',
          duration: 10,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        });
        gsap.to('.onboarding-aurora-layer-a', {
          xPercent: 26,
          yPercent: 18,
          rotation: 12,
          scale: 1.16,
          duration: 7.2,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        });
        gsap.to('.onboarding-aurora-layer-b', {
          xPercent: -24,
          yPercent: -20,
          rotation: -14,
          scale: 1.12,
          duration: 8.8,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
        });
        gsap
          .timeline({ repeat: -1, defaults: { ease: 'sine.inOut' } })
          .to('.onboarding-aurora-layer-c', {
            xPercent: -24,
            yPercent: -28,
            rotation: -8,
            scaleX: 1.18,
            duration: 5.4,
          })
          .to('.onboarding-aurora-layer-c', {
            xPercent: 26,
            yPercent: 22,
            rotation: 10,
            scaleX: 0.94,
            duration: 6.2,
          })
          .to('.onboarding-aurora-layer-c', {
            xPercent: 0,
            yPercent: 0,
            rotation: 0,
            scaleX: 1,
            duration: 5.4,
          });

        if (step === 'intro') {
          gsap.fromTo(
            '.onboarding-agent-orbit-item',
            { autoAlpha: 0, scale: 0.72, y: 18 },
            {
              autoAlpha: 1,
              scale: 1,
              y: 0,
              duration: 0.68,
              stagger: 0.08,
              ease: 'back.out(1.6)',
            }
          );
          gsap.to('.onboarding-agent-orbit-item', {
            y: 'random(-9, 9)',
            x: 'random(-5, 5)',
            duration: 'random(2.6, 4.2)',
            repeat: -1,
            yoyo: true,
            stagger: 0.14,
            ease: 'sine.inOut',
          });
        }
      });
      media.add('(prefers-reduced-motion: reduce)', () => {
        gsap.set(
          '.onboarding-step-copy > *, .onboarding-step-actions, .onboarding-agent-orbit-item',
          { autoAlpha: 1, x: 0, y: 0, scale: 1 }
        );
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
    setEnabledAgentIds(normalized.enabledAgentIds);
    setDefaultAgentId(normalized.defaultAgentId);
    setValidationError(null);
  };

  const selectDefault = (agentId: AgentId) => {
    const normalized = selectDefaultOnboardingAgent(enabledAgentIds, agentId);
    setEnabledAgentIds(normalized.enabledAgentIds);
    setDefaultAgentId(normalized.defaultAgentId);
    setValidationError(null);
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
      setSubmitError(error instanceof Error ? error.message : String(error));
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
    try {
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
                detail: error instanceof Error ? error.message : String(error),
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
              detail: error instanceof Error ? error.message : String(error),
            });
          });
      });
      setStep('welcome');
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
    }
  };

  const editorValid =
    editor.editor_type !== 'CUSTOM' || Boolean(editor.custom_command?.trim());

  if (!visible) return null;

  return (
    <PortalContainerContext.Provider value={portalContainer}>
      <div
        ref={captureRoot}
        className="legacy-design onboarding-experience"
        data-step={step}
      >
        <div className="onboarding-aurora" aria-hidden="true">
          <span className="onboarding-aurora-layer onboarding-aurora-layer-a" />
          <span className="onboarding-aurora-layer onboarding-aurora-layer-b" />
          <span className="onboarding-aurora-layer onboarding-aurora-layer-c" />
        </div>
        <div className="onboarding-noise" aria-hidden="true" />

        {step === 'intro' ? (
          <main className="onboarding-intro-step">
            <div
              className="onboarding-agent-orbit"
              aria-label={t('dialogs:onboarding.agentEcosystem')}
            >
              {INTRO_AGENTS.map((agent, index) => (
                <div
                  key={agent.id}
                  className="onboarding-agent-orbit-item"
                  data-position={index + 1}
                >
                  <span className="onboarding-agent-orbit-icon">
                    <IntroAgentIcon agent={agent} />
                  </span>
                  <span>{agent.label}</span>
                </div>
              ))}
            </div>

            <div className="onboarding-step-copy onboarding-intro-copy">
              <span className="onboarding-eyebrow">
                <Sparkles aria-hidden="true" />
                {APP_NAME}
              </span>
              <h1 id="onboarding-title" tabIndex={-1}>
                {t('dialogs:onboarding.journeyTitle')}
              </h1>
              <p>{t('dialogs:onboarding.journeyDescription')}</p>
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
                className="onboarding-skip-button"
                onClick={() => setStep('configure')}
              >
                {t('dialogs:onboarding.next')}
              </button>
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
            <div className="onboarding-config-grid">
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
                    loading={loadingAgents}
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
                    selectContentClassName="onboarding-popover-layer onboarding-editor-options"
                  />
                </div>
              </section>
            </div>

            <footer className="onboarding-config-footer">
              <p className="onboarding-safety-copy">
                <ShieldAlert aria-hidden="true" />
                {t('dialogs:onboarding.safetyNotice')}
              </p>
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
                  onClick={() => setStep('intro')}
                >
                  <ArrowLeft aria-hidden="true" />
                  {t('dialogs:onboarding.back')}
                </button>
                <button
                  type="button"
                  className="onboarding-skip-button"
                  disabled={submitting || !editorValid}
                  onClick={() => void handleStartSetup()}
                >
                  {submitting
                    ? t('dialogs:onboarding.startingInstall')
                    : t('dialogs:onboarding.startJourney')}
                </button>
              </div>
            </footer>
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
    </PortalContainerContext.Provider>
  );
}
