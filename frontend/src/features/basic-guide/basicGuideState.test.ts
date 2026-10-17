import { describe, expect, it } from 'vitest';

import {
  ACTIVE_GUIDE,
  COMPLETED_GUIDE,
  IDLE_GUIDE,
  advanceGuide,
  completeGuide,
  completeStep1,
  completeStep2,
  dismissEndCopy,
  isGuideVisible,
  isProjectRoute,
  parsePersistedBasicGuide,
  resolveLaunchState,
  restartBasicGuide,
  resumeBasicGuide,
  shouldCompleteStep1OnRoute,
  shouldForceWelcome,
  skipBasicGuide,
  startBasicGuide,
  clickAdvancesSubstep,
  conversationIdFromPathname,
  nextSubstep,
  shouldCompleteStep2FromAgentOutput,
  substepSpotlights,
} from './basicGuideState';

describe('basicGuideState', () => {
  it('restarts from step 1 when the first step was never finished', () => {
    const midStep2 = resumeBasicGuide({
      phase: 'active',
      reachedStep: 0,
      substep: 'click-new-session',
      endCopy: 'none',
    });
    expect(midStep2).toEqual({
      phase: 'active',
      reachedStep: 0,
      substep: 'select-project',
      endCopy: 'none',
    });
  });

  it('keeps an in-progress step 2 substep after relaunch', () => {
    const persisted = resumeBasicGuide({
      phase: 'active',
      reachedStep: 1,
      substep: 'send-hello',
      endCopy: 'none',
    });
    expect(persisted.substep).toBe('send-hello');
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

  it('starts the homepage tour after first-run finishes', () => {
    expect(startBasicGuide(IDLE_GUIDE)).toEqual(ACTIVE_GUIDE);
  });

  it('does not revive a skipped tour from finishFirstRun', () => {
    expect(startBasicGuide(skipBasicGuide())).toEqual(COMPLETED_GUIDE);
  });

  it('enters step 2 without an available Agent after the first project', () => {
    expect(completeStep1(ACTIVE_GUIDE, false).substep).toBe('need-agent');
    expect(completeStep1(ACTIVE_GUIDE, true).substep).toBe('click-new-session');
  });

  it('marks Agent output as step 2 complete', () => {
    const next = completeStep2({
      phase: 'active',
      reachedStep: 1,
      substep: 'send-hello',
      endCopy: 'none',
    });
    expect(next.reachedStep).toBe(2);
    expect(next.substep).toBe('rail-session-list');
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
        reachedStep: 2,
        substep: 'rail-session-list',
        endCopy: 'none',
      },
      'rail-file-tree'
    );
    expect(next.reachedStep).toBe(2);
    expect(next.substep).toBe('rail-file-tree');
  });

  it('treats a project sessions URL as entering a project', () => {
    expect(isProjectRoute('/local-projects/abc/sessions')).toBe(true);
    expect(isProjectRoute('/local-projects')).toBe(false);
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
          substep: 'click-new-session',
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

  it('migrates the old configure-session substep to the agent selector', () => {
    const parsed = parsePersistedBasicGuide(
      JSON.stringify({
        phase: 'active',
        reachedStep: 1,
        substep: 'configure-session',
        endCopy: 'none',
      })
    );
    expect(parsed?.substep).toBe('configure-session-agent');
  });

  it('splits session coaching into agent then config spotlights', () => {
    expect(
      substepSpotlights('select-project').map((item) => item.copyKey)
    ).toEqual([
      'select-project-create',
      'select-project-create',
      'select-project-global',
    ]);
    expect(substepSpotlights('click-new-session')[0]?.shape).toBe('circle');
    expect(substepSpotlights('kanban-create-session')).toEqual([
      { id: 'kanban-session-list', copyKey: 'kanban-create-session' },
      { id: 'kanban-session-list-new', shape: 'circle' },
    ]);
    expect(substepSpotlights('send-hello')).toEqual([
      { id: 'session-composer', copyKey: 'send-hello' },
      { id: 'session-send', shape: 'circle' },
    ]);
    expect(substepSpotlights('kanban-execution')).toEqual([
      { id: 'kanban-execution', copyKey: 'kanban-execution' },
    ]);
    expect(substepSpotlights('kanban-monitor')).toEqual([
      { id: 'kanban-monitor', copyKey: 'kanban-monitor' },
    ]);
    expect(nextSubstep('kanban-execution')).toBe('kanban-monitor');
    expect(substepSpotlights('configure-session-agent')[0]?.id).toBe(
      'session-agent-selector'
    );
    expect(substepSpotlights('configure-session-config')[0]?.id).toBe(
      'session-config'
    );
    expect(substepSpotlights('submit-session')[0]?.id).toBe(
      'session-create-submit'
    );
    expect(nextSubstep('configure-session-config')).toBe('submit-session');
    expect(
      clickAdvancesSubstep('configure-session-config', 'session-config')
    ).toBe(true);
  });

  it('reads a session id from the workspace session route', () => {
    expect(
      conversationIdFromPathname('/local-projects/p1/workspaces/w1/sessions/s1')
    ).toBe('s1');
    expect(
      conversationIdFromPathname('/local-projects/p1/sessions')
    ).toBeNull();
  });

  it('completes step 2 from agent output on any live session, including a later one', () => {
    const midConfig = {
      phase: 'active' as const,
      reachedStep: 1 as const,
      substep: 'configure-session-config' as const,
      endCopy: 'none' as const,
    };
    const sendHello = {
      ...midConfig,
      substep: 'send-hello' as const,
    };
    const append = { ops: [{ op: 'append_text' }] };
    const assistantUpsert = {
      ops: [
        {
          op: 'upsert',
          row: { row: { kind: 'message_turn', turn: { role: 'assistant' } } },
        },
      ],
    };
    const userUpsert = {
      ops: [
        {
          op: 'upsert',
          row: { row: { kind: 'message_turn', turn: { role: 'user' } } },
        },
      ],
    };
    expect(shouldCompleteStep2FromAgentOutput(midConfig, append)).toBe(true);
    expect(shouldCompleteStep2FromAgentOutput(sendHello, append)).toBe(true);
    expect(shouldCompleteStep2FromAgentOutput(sendHello, assistantUpsert)).toBe(
      true
    );
    expect(shouldCompleteStep2FromAgentOutput(sendHello, userUpsert)).toBe(
      false
    );
    expect(
      shouldCompleteStep2FromAgentOutput(
        { ...sendHello, phase: 'completed' },
        append
      )
    ).toBe(false);
  });

  it('advances usage and kanban clicks only on the coached control', () => {
    expect(
      clickAdvancesSubstep('kanban-create-session', 'kanban-session-list-new')
    ).toBe(true);
    expect(
      clickAdvancesSubstep('kanban-create-session', 'kanban-session-list')
    ).toBe(false);
    expect(
      clickAdvancesSubstep('usage-nav-overview', 'usage-nav-folders')
    ).toBe(false);
    expect(
      clickAdvancesSubstep('usage-nav-overview', 'usage-nav-overview')
    ).toBe(true);
    expect(clickAdvancesSubstep('need-agent', 'open-settings')).toBe(false);
    expect(clickAdvancesSubstep('need-agent', 'settings-nav-agents')).toBe(
      true
    );
  });
});
