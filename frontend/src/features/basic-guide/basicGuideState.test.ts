import { describe, expect, it } from 'vitest';

import {
  ACTIVE_GUIDE,
  COMPLETED_GUIDE,
  IDLE_GUIDE,
  SUBSTEP_META,
  advanceGuide,
  clickAdvancesSubstep,
  completeGuide,
  completeStep1,
  dismissEndCopy,
  isGuideVisible,
  isKanbanGuideSurface,
  isProjectRoute,
  nextSubstep,
  parsePersistedBasicGuide,
  reconcileLaunchStateForConfig,
  resolveLaunchState,
  restartBasicGuide,
  resumeBasicGuide,
  shouldCompleteStep1OnRoute,
  shouldForceWelcome,
  shouldRedirectToGuideWelcome,
  skipBasicGuide,
  startBasicGuide,
  substepSpotlights,
} from './basicGuideState';

describe('basicGuideState', () => {
  it('does not redirect to the guide welcome page while config is loading', () => {
    expect(
      shouldRedirectToGuideWelcome(ACTIVE_GUIDE, '/local-projects/demo', true)
    ).toBe(false);
    expect(
      shouldRedirectToGuideWelcome(ACTIVE_GUIDE, '/local-projects/demo', false)
    ).toBe(true);
  });

  it('restarts from step 1 when the first step was never finished', () => {
    const midStep = resumeBasicGuide({
      phase: 'active',
      reachedStep: 0,
      substep: 'toolbar-host-selector',
      endCopy: 'none',
    });
    expect(midStep).toEqual({
      phase: 'active',
      reachedStep: 0,
      substep: 'select-project',
      endCopy: 'none',
    });
  });

  it('keeps an in-progress main-window substep after relaunch', () => {
    const persisted = resumeBasicGuide({
      phase: 'active',
      reachedStep: 1,
      substep: 'project-switcher',
      endCopy: 'none',
    });
    expect(persisted.substep).toBe('project-switcher');
  });

  it('skips the tour for existing users who already finished first-run', () => {
    expect(
      resolveLaunchState({ raw: null, onboardingAcknowledged: true })
    ).toEqual(COMPLETED_GUIDE);
  });

  it('waits for first-run when onboarding is still open', () => {
    expect(
      resolveLaunchState({ raw: null, onboardingAcknowledged: false })
    ).toEqual(IDLE_GUIDE);
  });

  it('reconciles stale completed or main-window guide state back to idle when onboarding is not acknowledged', () => {
    expect(
      reconcileLaunchStateForConfig({
        state: COMPLETED_GUIDE,
        hasPersistedGuide: true,
        onboardingAcknowledged: false,
        configLoading: true,
      })
    ).toBeNull();
    expect(
      reconcileLaunchStateForConfig({
        state: COMPLETED_GUIDE,
        hasPersistedGuide: true,
        onboardingAcknowledged: false,
        configLoading: false,
      })
    ).toEqual(IDLE_GUIDE);
    expect(
      reconcileLaunchStateForConfig({
        state: {
          phase: 'active',
          reachedStep: 1,
          substep: 'toolbar-host-selector',
          endCopy: 'none',
        },
        hasPersistedGuide: true,
        onboardingAcknowledged: false,
        configLoading: false,
      })
    ).toEqual(IDLE_GUIDE);
    expect(
      reconcileLaunchStateForConfig({
        state: COMPLETED_GUIDE,
        hasPersistedGuide: true,
        onboardingAcknowledged: false,
        configLoading: false,
        skippedInSession: true,
      })
    ).toBeNull();
    expect(
      reconcileLaunchStateForConfig({
        state: ACTIVE_GUIDE,
        hasPersistedGuide: true,
        onboardingAcknowledged: false,
        configLoading: false,
      })
    ).toBeNull();
    expect(
      reconcileLaunchStateForConfig({
        state: IDLE_GUIDE,
        hasPersistedGuide: false,
        onboardingAcknowledged: true,
        configLoading: false,
      })
    ).toEqual(COMPLETED_GUIDE);
  });

  it('starts the project selection tour when activating from idle', () => {
    expect(startBasicGuide(IDLE_GUIDE)).toEqual(ACTIVE_GUIDE);
  });

  it('does not revive a skipped tour from finishFirstRun', () => {
    expect(startBasicGuide(skipBasicGuide())).toEqual(COMPLETED_GUIDE);
  });

  it('enters the main-window Host selector tour after selecting a project', () => {
    const next = completeStep1(ACTIVE_GUIDE);
    expect(next.reachedStep).toBe(1);
    expect(next.substep).toBe('toolbar-host-selector');
  });

  it('walks through Host selector, Project selector, and 4 rail buttons in order and ends after rail-git', () => {
    expect(nextSubstep('select-project')).toBe('toolbar-host-selector');
    expect(nextSubstep('toolbar-host-selector')).toBe('project-switcher');
    expect(nextSubstep('project-switcher')).toBe('rail-session-list');
    expect(nextSubstep('rail-session-list')).toBe('rail-bots');
    expect(nextSubstep('rail-bots')).toBe('rail-file-tree');
    expect(nextSubstep('rail-file-tree')).toBe('rail-git');
    expect(nextSubstep('rail-git')).toBeNull();
    expect(nextSubstep('show-end')).toBeNull();
  });

  it('auto-completes legacy active show-end state on resume', () => {
    expect(
      resumeBasicGuide({
        phase: 'active',
        reachedStep: 2,
        substep: 'show-end',
        endCopy: 'none',
      })
    ).toEqual({
      phase: 'completed',
      reachedStep: 2,
      substep: 'show-end',
      endCopy: 'finished',
    });
  });

  it('keeps Continue enabled for all main-window tour steps and allows clicking rail targets', () => {
    expect(SUBSTEP_META['toolbar-host-selector'].advance).toBe('continue');
    expect(SUBSTEP_META['toolbar-host-selector'].continueVisible).toBe(true);
    expect(SUBSTEP_META['project-switcher'].advance).toBe('continue');
    expect(SUBSTEP_META['project-switcher'].continueVisible).toBe(true);
    for (const rail of [
      'rail-session-list',
      'rail-bots',
      'rail-file-tree',
      'rail-git',
    ] as const) {
      expect(SUBSTEP_META[rail].advance).toBe('click');
      expect(SUBSTEP_META[rail].continueVisible).toBe(true);
      expect(clickAdvancesSubstep(rail, rail)).toBe(true);
    }
    expect(clickAdvancesSubstep('rail-bots', 'rail-git')).toBe(false);
  });

  it('shows the end copy after exiting or finishing', () => {
    const exited = completeGuide(ACTIVE_GUIDE, 'exited');
    expect(exited.phase).toBe('completed');
    expect(exited.endCopy).toBe('exited');
    expect(isGuideVisible(exited)).toBe(true);
    expect(isGuideVisible(dismissEndCopy(exited))).toBe(false);
  });

  it('restarts from settings at step 1', () => {
    expect(restartBasicGuide().substep).toBe('select-project');
    expect(restartBasicGuide().reachedStep).toBe(0);
  });

  it('advances a later substep without dropping reachedStep', () => {
    const next = advanceGuide(
      {
        phase: 'active',
        reachedStep: 1,
        substep: 'rail-file-tree',
        endCopy: 'none',
      },
      'show-end'
    );
    expect(next.reachedStep).toBe(2);
    expect(next.substep).toBe('show-end');
  });

  it('treats a project sessions URL as entering a project', () => {
    expect(isProjectRoute('/local-projects/abc/sessions')).toBe(true);
    expect(isProjectRoute('/local-projects')).toBe(false);
  });

  it('pins the step panel closer on the kanban surface', () => {
    expect(isKanbanGuideSurface('/local-projects/abc', 'kanban')).toBe(true);
    expect(isKanbanGuideSurface('/local-projects/abc', 'workspace')).toBe(
      false
    );
    expect(
      isKanbanGuideSurface(
        '/local-projects/abc/workspaces/w1/sessions/s1',
        'kanban'
      )
    ).toBe(false);
    expect(isKanbanGuideSurface('/', 'kanban')).toBe(false);
  });

  it('rejects corrupt storage', () => {
    expect(parsePersistedBasicGuide('{')).toBeNull();
    expect(parsePersistedBasicGuide('{"phase":"nope"}')).toBeNull();
  });

  it('returns to the welcome page when step 1 is unfinished', () => {
    expect(
      shouldForceWelcome(ACTIVE_GUIDE, '/local-projects/abc/sessions')
    ).toBe(true);
    expect(shouldForceWelcome(ACTIVE_GUIDE, '/local-projects')).toBe(false);
    expect(
      shouldForceWelcome(
        {
          phase: 'active',
          reachedStep: 1,
          substep: 'toolbar-host-selector',
          endCopy: 'none',
        },
        '/local-projects/abc/sessions'
      )
    ).toBe(false);
  });

  it('completes step 1 only after leaving the welcome page for a project', () => {
    expect(
      shouldCompleteStep1OnRoute(
        ACTIVE_GUIDE,
        '/local-projects',
        '/local-projects/abc/sessions'
      )
    ).toBe(true);
    expect(
      shouldCompleteStep1OnRoute(
        ACTIVE_GUIDE,
        '/local-projects/abc/sessions',
        '/local-projects/abc/sessions'
      )
    ).toBe(false);
  });

  it('migrates legacy persisted active substeps to toolbar-host-selector when reachedStep >= 1', () => {
    const parsed = parsePersistedBasicGuide(
      JSON.stringify({
        phase: 'active',
        reachedStep: 1,
        substep: 'click-new-session',
        endCopy: 'none',
      })
    );
    expect(parsed?.substep).toBe('toolbar-host-selector');
    expect(parsed?.reachedStep).toBe(1);
  });

  it('defines spotlights for select-project and each main-window target', () => {
    expect(
      substepSpotlights('select-project').map((item) => item.copyKey)
    ).toEqual([
      'select-project-create',
      'select-project-create',
      'select-project-global',
      'select-project-list',
    ]);
    expect(substepSpotlights('toolbar-host-selector')).toEqual([
      {
        id: 'toolbar-host-selector',
        copyKey: 'toolbar-host-selector',
        padding: 2,
      },
    ]);
    expect(substepSpotlights('project-switcher')).toEqual([
      {
        id: 'project-switcher',
        copyKey: 'project-switcher',
        padding: 2,
      },
    ]);
    expect(substepSpotlights('rail-bots')).toEqual([
      { id: 'rail-bots', copyKey: 'rail-bots' },
    ]);
  });
});
