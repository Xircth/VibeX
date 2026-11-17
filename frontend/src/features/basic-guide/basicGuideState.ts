import type { SpotlightTarget } from './spotlightGeometry';

export const BASIC_GUIDE_STORAGE_KEY = 'dimo:basic-guide';
export const BASIC_GUIDE_CHANGED_EVENT = 'dimo:basic-guide-changed';

export type GuideSpotlightTarget = SpotlightTarget;

export type BasicGuidePhase = 'idle' | 'active' | 'completed';
export type BasicGuideReachedStep = 0 | 1 | 2;
export type BasicGuideEndCopy = 'none' | 'finished' | 'exited';

export type BasicGuideSubstep =
  | 'select-project'
  | 'toolbar-host-selector'
  | 'project-switcher'
  | 'rail-session-list'
  | 'rail-bots'
  | 'rail-file-tree'
  | 'rail-git'
  | 'show-end';

export type BasicGuideAdvance = 'route' | 'click' | 'continue' | 'finish';

export type PersistedBasicGuide = {
  phase: BasicGuidePhase;
  reachedStep: BasicGuideReachedStep;
  substep: BasicGuideSubstep;
  endCopy: BasicGuideEndCopy;
};

export const SUBSTEP_ORDER: readonly BasicGuideSubstep[] = [
  'select-project',
  'toolbar-host-selector',
  'project-switcher',
  'rail-session-list',
  'rail-bots',
  'rail-file-tree',
  'rail-git',
  'show-end',
];

const SUBSTEPS = new Set<string>(SUBSTEP_ORDER);

export type GuideStepTarget = {
  id: string;
  required?: boolean;
};

type SubstepMeta = {
  mainStep: 1 | 2 | 3;
  targets: readonly string[];
  advance: BasicGuideAdvance;
  continueVisible: boolean;
  spotlights?: readonly GuideSpotlightTarget[];
};

export const SUBSTEP_META: Record<BasicGuideSubstep, SubstepMeta> = {
  'select-project': {
    mainStep: 1,
    targets: [
      'welcome-create-project',
      'welcome-select-folder',
      'welcome-global-project',
      'welcome-project-list',
    ],
    advance: 'route',
    continueVisible: false,
    spotlights: [
      {
        id: 'welcome-create-project',
        copyKey: 'select-project-create',
        group: 'welcome-start',
      },
      {
        id: 'welcome-select-folder',
        copyKey: 'select-project-create',
        group: 'welcome-start',
      },
      {
        id: 'welcome-global-project',
        copyKey: 'select-project-global',
      },
      {
        id: 'welcome-project-list',
        copyKey: 'select-project-list',
        shape: 'rect',
      },
    ],
  },
  'toolbar-host-selector': {
    mainStep: 2,
    targets: ['toolbar-host-selector'],
    advance: 'continue',
    continueVisible: true,
    spotlights: [
      {
        id: 'toolbar-host-selector',
        copyKey: 'toolbar-host-selector',
        padding: 2,
      },
    ],
  },
  'project-switcher': {
    mainStep: 2,
    targets: ['project-switcher'],
    advance: 'continue',
    continueVisible: true,
    spotlights: [
      {
        id: 'project-switcher',
        copyKey: 'project-switcher',
        padding: 2,
      },
    ],
  },
  'rail-session-list': {
    mainStep: 2,
    targets: ['rail-session-list'],
    advance: 'click',
    continueVisible: true,
  },
  'rail-bots': {
    mainStep: 2,
    targets: ['rail-bots'],
    advance: 'click',
    continueVisible: true,
  },
  'rail-file-tree': {
    mainStep: 2,
    targets: ['rail-file-tree'],
    advance: 'click',
    continueVisible: true,
  },
  'rail-git': {
    mainStep: 2,
    targets: ['rail-git'],
    advance: 'click',
    continueVisible: true,
  },
  'show-end': {
    mainStep: 3,
    targets: ['guide-finish'],
    advance: 'finish',
    continueVisible: false,
  },
};

export const IDLE_GUIDE: PersistedBasicGuide = {
  phase: 'idle',
  reachedStep: 0,
  substep: 'select-project',
  endCopy: 'none',
};

export const ACTIVE_GUIDE: PersistedBasicGuide = {
  phase: 'active',
  reachedStep: 0,
  substep: 'select-project',
  endCopy: 'none',
};

export const COMPLETED_GUIDE: PersistedBasicGuide = {
  phase: 'completed',
  reachedStep: 2,
  substep: 'show-end',
  endCopy: 'none',
};

function isReachedStep(value: unknown): value is BasicGuideReachedStep {
  return value === 0 || value === 1 || value === 2;
}

function isSubstep(value: unknown): value is BasicGuideSubstep {
  return typeof value === 'string' && SUBSTEPS.has(value);
}

export function parsePersistedBasicGuide(
  raw: string | null
): PersistedBasicGuide | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedBasicGuide>;
    if (
      parsed.phase !== 'idle' &&
      parsed.phase !== 'active' &&
      parsed.phase !== 'completed'
    ) {
      return null;
    }
    if (!isReachedStep(parsed.reachedStep)) return null;
    const rawSubstep = typeof parsed.substep === 'string' ? parsed.substep : '';
    const substep: BasicGuideSubstep = isSubstep(rawSubstep)
      ? rawSubstep
      : parsed.reachedStep >= 1
        ? 'toolbar-host-selector'
        : 'select-project';
    const reachedStep: BasicGuideReachedStep =
      parsed.phase === 'active' &&
      substep !== 'select-project' &&
      parsed.reachedStep === 0
        ? 1
        : parsed.reachedStep;
    const endCopy =
      parsed.endCopy === 'finished' || parsed.endCopy === 'exited'
        ? parsed.endCopy
        : 'none';
    return {
      phase: parsed.phase,
      reachedStep,
      substep,
      endCopy,
    };
  } catch {
    return null;
  }
}

export function resumeBasicGuide(
  persisted: PersistedBasicGuide
): PersistedBasicGuide {
  if (persisted.phase !== 'active') return persisted;
  if (persisted.reachedStep === 0) {
    return { ...persisted, substep: 'select-project', endCopy: 'none' };
  }
  if (persisted.substep === 'show-end') {
    return completeGuide(persisted, 'finished');
  }
  return persisted;
}

export function resolveLaunchState({
  raw,
  onboardingAcknowledged,
}: {
  raw: string | null;
  onboardingAcknowledged: boolean;
}): PersistedBasicGuide {
  const parsed = parsePersistedBasicGuide(raw);
  if (parsed) return resumeBasicGuide(parsed);
  if (onboardingAcknowledged) return COMPLETED_GUIDE;
  return IDLE_GUIDE;
}

export function reconcileLaunchStateForConfig({
  state,
  hasPersistedGuide,
  onboardingAcknowledged,
  configLoading,
  skippedInSession = false,
}: {
  state: PersistedBasicGuide;
  hasPersistedGuide: boolean;
  onboardingAcknowledged: boolean;
  configLoading: boolean;
  skippedInSession?: boolean;
}): PersistedBasicGuide | null {
  if (configLoading) return null;
  if (!onboardingAcknowledged) {
    if (skippedInSession) return null;
    if (
      state.phase === 'completed' ||
      state.reachedStep > 0 ||
      (state.phase === 'active' && state.substep !== 'select-project')
    ) {
      return { ...IDLE_GUIDE };
    }
    return null;
  }
  if (!hasPersistedGuide) {
    const next = resolveLaunchState({
      raw: null,
      onboardingAcknowledged: true,
    });
    if (next.phase === 'completed' && state.phase !== 'completed') {
      return next;
    }
  }
  return null;
}

export function startBasicGuide(
  current?: PersistedBasicGuide | null
): PersistedBasicGuide {
  if (current?.phase === 'completed' && current.endCopy === 'none') {
    return current;
  }
  return { ...ACTIVE_GUIDE };
}

export function restartBasicGuide(): PersistedBasicGuide {
  return { ...ACTIVE_GUIDE };
}

export function skipBasicGuide(): PersistedBasicGuide {
  return { ...COMPLETED_GUIDE };
}

export function reachedStepAfter(
  substep: BasicGuideSubstep
): BasicGuideReachedStep {
  const main = SUBSTEP_META[substep].mainStep;
  if (main <= 1) return 0;
  if (main === 2) return 1;
  return 2;
}

export function nextSubstep(
  substep: BasicGuideSubstep
): BasicGuideSubstep | null {
  const index = SUBSTEP_ORDER.indexOf(substep);
  if (index < 0 || index >= SUBSTEP_ORDER.length - 1) return null;
  const next = SUBSTEP_ORDER[index + 1] ?? null;
  return next === 'show-end' ? null : next;
}

export function advanceGuide(
  state: PersistedBasicGuide,
  next: BasicGuideSubstep
): PersistedBasicGuide {
  if (state.phase !== 'active') return state;
  return {
    ...state,
    substep: next,
    reachedStep: Math.max(
      state.reachedStep,
      reachedStepAfter(next)
    ) as BasicGuideReachedStep,
  };
}

export function completeStep1(
  state: PersistedBasicGuide,
  _hasAvailableAgent = true
): PersistedBasicGuide {
  if (state.phase !== 'active' || state.reachedStep > 0) {
    return state;
  }
  return {
    phase: 'active',
    reachedStep: 1,
    substep: 'toolbar-host-selector',
    endCopy: 'none',
  };
}

export function completeGuide(
  _state: PersistedBasicGuide,
  reason: Exclude<BasicGuideEndCopy, 'none'>
): PersistedBasicGuide {
  return {
    phase: 'completed',
    reachedStep: 2,
    substep: 'show-end',
    endCopy: reason,
  };
}

export function dismissEndCopy(
  state: PersistedBasicGuide
): PersistedBasicGuide {
  if (state.phase !== 'completed') return state;
  return { ...state, endCopy: 'none' };
}

export function isGuideVisible(state: PersistedBasicGuide): boolean {
  return (
    state.phase === 'active' ||
    (state.phase === 'completed' && state.endCopy !== 'none')
  );
}

export function isProjectRoute(pathname: string): boolean {
  return /^\/local-projects\/[^/]+/u.test(pathname);
}

export function isKanbanGuideSurface(
  pathname: string,
  activeTab: string
): boolean {
  return (
    isProjectRoute(pathname) &&
    !isSettingsRoute(pathname) &&
    !/\/workspaces\//u.test(pathname) &&
    activeTab === 'kanban'
  );
}

export function isWelcomeRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/local-projects' ||
    pathname === '/local-projects/'
  );
}

export function isSettingsRoute(pathname: string): boolean {
  return pathname.startsWith('/settings') || pathname.startsWith('/plugins');
}

export function shouldForceWelcome(
  state: PersistedBasicGuide,
  pathname: string
): boolean {
  return (
    state.phase === 'active' &&
    state.reachedStep === 0 &&
    isProjectRoute(pathname) &&
    !isSettingsRoute(pathname)
  );
}

export function shouldRedirectToGuideWelcome(
  state: PersistedBasicGuide,
  pathname: string,
  configLoading: boolean
): boolean {
  return !configLoading && shouldForceWelcome(state, pathname);
}

export function shouldCompleteStep1OnRoute(
  state: PersistedBasicGuide,
  previousPathname: string,
  pathname: string
): boolean {
  return (
    state.phase === 'active' &&
    state.reachedStep === 0 &&
    state.substep === 'select-project' &&
    isWelcomeRoute(previousPathname) &&
    isProjectRoute(pathname)
  );
}

export function substepSpotlights(
  substep: BasicGuideSubstep
): GuideSpotlightTarget[] {
  const meta = SUBSTEP_META[substep];
  if (meta.spotlights && meta.spotlights.length > 0) {
    return [...meta.spotlights];
  }
  if (meta.targets.length > 0) {
    return meta.targets.map((id) => ({ id, copyKey: substep }));
  }
  return [{ id: '', copyKey: substep }];
}

export function clickAdvancesSubstep(
  substep: BasicGuideSubstep,
  targetId: string
): boolean {
  return SUBSTEP_META[substep].targets.includes(targetId);
}

export function isElementInertOrHidden(node: HTMLElement): boolean {
  let current: HTMLElement | null = node;
  while (current) {
    if (
      current.inert ||
      current.hidden ||
      current.hasAttribute('inert') ||
      current.hasAttribute('hidden') ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}
