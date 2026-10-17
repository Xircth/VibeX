import type { SpotlightTarget } from './spotlightGeometry';

export const BASIC_GUIDE_STORAGE_KEY = 'vibex:basic-guide';
export const BASIC_GUIDE_CHANGED_EVENT = 'vibex:basic-guide-changed';
export const BASIC_GUIDE_OPEN_AGENT_STATUS_EVENT =
  'vibex:basic-guide-open-agent-status';
export const BASIC_GUIDE_SESSION_AGENT_EVENT =
  'vibex:basic-guide-session-agent';
export const BASIC_GUIDE_HELLO = '你好';

export type GuideSpotlightTarget = SpotlightTarget;

export type BasicGuidePhase = 'idle' | 'active' | 'completed';
export type BasicGuideReachedStep = 0 | 1 | 2;
export type BasicGuideEndCopy = 'none' | 'finished' | 'exited';

export type BasicGuideSubstep =
  | 'select-project'
  | 'need-agent'
  | 'settings-agent-icon'
  | 'settings-agent-enable'
  | 'settings-agent-acp'
  | 'settings-agent-auth'
  | 'return-main'
  | 'click-new-session'
  | 'configure-session-agent'
  | 'configure-session-config'
  | 'submit-session'
  | 'send-hello'
  | 'rail-session-list'
  | 'rail-file-tree'
  | 'rail-git'
  | 'click-kanban'
  | 'kanban-create-session'
  | 'kanban-click-sessions'
  | 'kanban-execution'
  | 'kanban-monitor'
  | 'kanban-move-to-execution'
  | 'usage-next-page'
  | 'usage-overview-cards'
  | 'usage-nav-overview'
  | 'usage-nav-folders'
  | 'usage-nav-agents'
  | 'usage-nav-models'
  | 'usage-nav-sessions'
  | 'usage-nav-plan'
  | 'show-end';

export type BasicGuideAdvance =
  | 'route'
  | 'click'
  | 'auto'
  | 'continue'
  | 'finish';

export type PersistedBasicGuide = {
  phase: BasicGuidePhase;
  reachedStep: BasicGuideReachedStep;
  substep: BasicGuideSubstep;
  endCopy: BasicGuideEndCopy;
};

export const SUBSTEP_ORDER: readonly BasicGuideSubstep[] = [
  'select-project',
  'need-agent',
  'settings-agent-icon',
  'settings-agent-enable',
  'settings-agent-acp',
  'settings-agent-auth',
  'return-main',
  'click-new-session',
  'configure-session-agent',
  'configure-session-config',
  'submit-session',
  'send-hello',
  'rail-session-list',
  'rail-file-tree',
  'rail-git',
  'click-kanban',
  'kanban-create-session',
  'kanban-click-sessions',
  'kanban-execution',
  'kanban-monitor',
  'kanban-move-to-execution',
  'usage-next-page',
  'usage-overview-cards',
  'usage-nav-overview',
  'usage-nav-folders',
  'usage-nav-agents',
  'usage-nav-models',
  'usage-nav-sessions',
  'usage-nav-plan',
  'show-end',
];

const SUBSTEPS = new Set<string>(SUBSTEP_ORDER);

export const GUIDE_STEP_TITLES = [
  'createProject',
  'createSession',
  'learnLayout',
] as const;

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
    ],
  },
  'need-agent': {
    mainStep: 2,
    targets: ['open-settings', 'settings-nav-agents'],
    advance: 'click',
    continueVisible: false,
  },
  'settings-agent-icon': {
    mainStep: 2,
    targets: ['settings-agent-bar'],
    advance: 'click',
    continueVisible: false,
  },
  'settings-agent-enable': {
    mainStep: 2,
    targets: ['settings-agent-enable'],
    advance: 'auto',
    continueVisible: false,
  },
  'settings-agent-acp': {
    mainStep: 2,
    targets: ['settings-agent-enable'],
    advance: 'auto',
    continueVisible: false,
  },
  'settings-agent-auth': {
    mainStep: 2,
    targets: ['settings-agent-auth'],
    advance: 'auto',
    continueVisible: false,
  },
  'return-main': {
    mainStep: 2,
    targets: [],
    advance: 'continue',
    continueVisible: true,
  },
  'click-new-session': {
    mainStep: 2,
    targets: ['toolbar-new-session'],
    advance: 'click',
    continueVisible: false,
    spotlights: [
      {
        id: 'toolbar-new-session',
        copyKey: 'click-new-session',
        shape: 'circle',
      },
    ],
  },
  'configure-session-agent': {
    mainStep: 2,
    targets: ['session-agent-selector'],
    advance: 'auto',
    continueVisible: true,
  },
  'configure-session-config': {
    mainStep: 2,
    targets: ['session-config'],
    advance: 'click',
    continueVisible: true,
  },
  'submit-session': {
    mainStep: 2,
    targets: ['session-create-submit'],
    advance: 'click',
    continueVisible: true,
  },
  'send-hello': {
    mainStep: 2,
    targets: ['session-composer', 'session-send'],
    advance: 'auto',
    continueVisible: false,
    spotlights: [
      {
        id: 'session-composer',
        copyKey: 'send-hello',
      },
      {
        id: 'session-send',
        shape: 'circle',
      },
    ],
  },
  'rail-session-list': {
    mainStep: 3,
    targets: ['rail-session-list'],
    advance: 'click',
    continueVisible: false,
  },
  'rail-file-tree': {
    mainStep: 3,
    targets: ['rail-file-tree'],
    advance: 'click',
    continueVisible: false,
  },
  'rail-git': {
    mainStep: 3,
    targets: ['rail-git'],
    advance: 'click',
    continueVisible: false,
  },
  'click-kanban': {
    mainStep: 3,
    targets: ['toolbar-kanban'],
    advance: 'click',
    continueVisible: false,
  },
  'kanban-create-session': {
    mainStep: 3,
    targets: ['kanban-session-list', 'kanban-session-list-new'],
    advance: 'click',
    continueVisible: false,
    spotlights: [
      {
        id: 'kanban-session-list',
        copyKey: 'kanban-create-session',
      },
      {
        id: 'kanban-session-list-new',
        shape: 'circle',
      },
    ],
  },
  'kanban-click-sessions': {
    mainStep: 3,
    targets: ['kanban-session-list', 'kanban-session-item'],
    advance: 'click',
    continueVisible: true,
  },
  'kanban-execution': {
    mainStep: 3,
    targets: ['kanban-execution', 'kanban-monitor'],
    advance: 'continue',
    continueVisible: true,
    spotlights: [
      {
        id: 'kanban-execution',
        copyKey: 'kanban-execution',
      },
      {
        id: 'kanban-monitor',
        copyKey: 'kanban-monitor',
      },
    ],
  },
  'kanban-monitor': {
    mainStep: 3,
    targets: ['kanban-monitor'],
    advance: 'continue',
    continueVisible: true,
  },
  'kanban-move-to-execution': {
    mainStep: 3,
    targets: ['kanban-move-to-execution'],
    advance: 'click',
    continueVisible: true,
  },
  'usage-next-page': {
    mainStep: 3,
    targets: ['kanban-next-page'],
    advance: 'click',
    continueVisible: false,
  },
  'usage-overview-cards': {
    mainStep: 3,
    targets: ['usage-overview-cards'],
    advance: 'continue',
    continueVisible: true,
  },
  'usage-nav-overview': {
    mainStep: 3,
    targets: ['usage-nav', 'usage-nav-overview'],
    advance: 'click',
    continueVisible: true,
  },
  'usage-nav-folders': {
    mainStep: 3,
    targets: ['usage-nav', 'usage-nav-folders'],
    advance: 'click',
    continueVisible: true,
  },
  'usage-nav-agents': {
    mainStep: 3,
    targets: ['usage-nav', 'usage-nav-agents'],
    advance: 'click',
    continueVisible: true,
  },
  'usage-nav-models': {
    mainStep: 3,
    targets: ['usage-nav', 'usage-nav-models'],
    advance: 'click',
    continueVisible: true,
  },
  'usage-nav-sessions': {
    mainStep: 3,
    targets: ['usage-nav', 'usage-nav-sessions'],
    advance: 'click',
    continueVisible: true,
  },
  'usage-nav-plan': {
    mainStep: 3,
    targets: ['usage-nav', 'usage-nav-plan'],
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
    const rawSubstep: string =
      typeof parsed.substep === 'string' ? String(parsed.substep) : '';
    const migratedSubstep =
      rawSubstep === 'configure-session'
        ? 'configure-session-agent'
        : rawSubstep;
    const substep = isSubstep(migratedSubstep)
      ? migratedSubstep
      : 'select-project';
    const endCopy =
      parsed.endCopy === 'finished' || parsed.endCopy === 'exited'
        ? parsed.endCopy
        : 'none';
    return {
      phase: parsed.phase,
      reachedStep: parsed.reachedStep,
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

export function mainStepIndex(substep: BasicGuideSubstep): 0 | 1 | 2 {
  return (SUBSTEP_META[substep].mainStep - 1) as 0 | 1 | 2;
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
  return SUBSTEP_ORDER[index + 1] ?? null;
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
  hasAvailableAgent: boolean
): PersistedBasicGuide {
  if (state.phase !== 'active' || state.reachedStep > 0) {
    return state;
  }
  return {
    phase: 'active',
    reachedStep: 1,
    substep: hasAvailableAgent ? 'click-new-session' : 'need-agent',
    endCopy: 'none',
  };
}

export function completeStep2(state: PersistedBasicGuide): PersistedBasicGuide {
  if (state.phase !== 'active') return state;
  return {
    phase: 'active',
    reachedStep: 2,
    substep: 'rail-session-list',
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

export function sessionCreateHrefLooksOpen(search: string): boolean {
  const params = new URLSearchParams(search);
  return (
    params.get('newSession') === '1' || params.get('createSession') === '1'
  );
}

export function isProjectRoute(pathname: string): boolean {
  return /^\/local-projects\/[^/]+/u.test(pathname);
}

export function isWelcomeRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/local-projects' ||
    pathname === '/local-projects/'
  );
}

export function isSettingsAgentsRoute(pathname: string): boolean {
  return (
    pathname === '/settings/agents' || pathname.startsWith('/settings/agents/')
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

export function isConfigureSessionSubstep(substep: BasicGuideSubstep): boolean {
  return (
    substep === 'configure-session-agent' ||
    substep === 'configure-session-config' ||
    substep === 'submit-session'
  );
}

export function isStep2LiveSessionSubstep(substep: BasicGuideSubstep): boolean {
  return isConfigureSessionSubstep(substep) || substep === 'send-hello';
}

export function conversationIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/\/workspaces\/[^/]+\/sessions\/([^/?#]+)\/?$/);
  return match?.[1] ?? null;
}

export function batchShowsAgentOutput(batch: {
  ops: Array<{
    op: string;
    row?: { row?: { kind?: string; turn?: { role?: string } } };
  }>;
}): boolean {
  return batch.ops.some((op) => {
    if (op.op === 'append_text') return true;
    if (op.op !== 'upsert') return false;
    return (
      op.row?.row?.kind === 'message_turn' &&
      op.row.row.turn?.role === 'assistant'
    );
  });
}

export function shouldCompleteStep2FromAgentOutput(
  state: PersistedBasicGuide,
  batch: Parameters<typeof batchShowsAgentOutput>[0]
): boolean {
  return (
    state.phase === 'active' &&
    isStep2LiveSessionSubstep(state.substep) &&
    batchShowsAgentOutput(batch)
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
  switch (substep) {
    case 'need-agent':
      return targetId === 'settings-nav-agents';
    case 'kanban-create-session':
      return targetId === 'kanban-session-list-new';
    case 'kanban-click-sessions':
      return targetId === 'kanban-session-item';
    case 'usage-nav-overview':
    case 'usage-nav-folders':
    case 'usage-nav-agents':
    case 'usage-nav-models':
    case 'usage-nav-sessions':
    case 'usage-nav-plan':
      return targetId === substep;
    default:
      return SUBSTEP_META[substep].targets.includes(targetId);
  }
}
