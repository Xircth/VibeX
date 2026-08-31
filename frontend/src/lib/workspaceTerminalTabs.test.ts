import { afterEach, describe, expect, it } from 'vitest';

import { PANEL_IDS } from '@/stores/useLayoutStore';

import {
  clampTerminalListPaneWidth,
  editorTerminalPanelId,
  isEditorTerminalPanelId,
  isWorkspacePanelTerminal,
  lastTerminalCloseHidesPanel,
  nextWorkspaceTerminalTitle,
  persistTerminalListPaneWidth,
  readStoredTerminalListPaneWidth,
  reduceTerminalBusy,
  shouldCreateInitialTerminal,
  tabIdFromEditorTerminalPanelId,
  TERMINAL_LIST_PANE_DEFAULT_WIDTH,
  TERMINAL_LIST_PANE_MAX_WIDTH,
  TERMINAL_LIST_PANE_MIN_WIDTH,
  TERMINAL_LIST_PANE_STORAGE_KEY,
  terminalTitleSlug,
} from './workspaceTerminalTabs';

describe('workspace terminal titles', () => {
  it('names the first tab after the default shell', () => {
    expect(nextWorkspaceTerminalTitle('zsh', [])).toBe('zsh-01');
    expect(nextWorkspaceTerminalTitle('bash', [])).toBe('bash-01');
    expect(nextWorkspaceTerminalTitle('powershell.exe', [])).toBe(
      'powershell-01'
    );
  });

  it('skips titles that are already in use', () => {
    expect(nextWorkspaceTerminalTitle('zsh', ['zsh-01', 'zsh-02'])).toBe(
      'zsh-03'
    );
    expect(nextWorkspaceTerminalTitle('zsh', ['zsh-01', 'zsh-03'])).toBe(
      'zsh-02'
    );
  });

  it('slugs Windows and path-qualified shells', () => {
    expect(terminalTitleSlug('cmd.exe')).toBe('cmd');
    expect(terminalTitleSlug('/usr/bin/zsh')).toBe('zsh');
  });
});

describe('workspace terminal lifecycle policy', () => {
  it('creates one tab only when the panel is visible and empty', () => {
    expect(
      shouldCreateInitialTerminal({
        panelVisible: true,
        sessionCount: 0,
        isExternalShell: false,
      })
    ).toBe(true);
    expect(
      shouldCreateInitialTerminal({
        panelVisible: false,
        sessionCount: 0,
        isExternalShell: false,
      })
    ).toBe(false);
    expect(
      shouldCreateInitialTerminal({
        panelVisible: true,
        sessionCount: 1,
        isExternalShell: false,
      })
    ).toBe(false);
  });

  it('hides the panel after the last tab is closed', () => {
    expect(lastTerminalCloseHidesPanel(0)).toBe(true);
    expect(lastTerminalCloseHidesPanel(1)).toBe(false);
  });
});

describe('workspace terminal surfaces', () => {
  it('keeps the bottom panel id distinct from editor-tab panel ids', () => {
    expect(isEditorTerminalPanelId(PANEL_IDS.TERMINAL)).toBe(false);
    expect(isEditorTerminalPanelId(editorTerminalPanelId('term-1'))).toBe(true);
    expect(tabIdFromEditorTerminalPanelId(PANEL_IDS.TERMINAL)).toBeNull();
    expect(tabIdFromEditorTerminalPanelId('terminal:term-1')).toBe('term-1');
  });

  it('hides editor-tab sessions from the bottom terminal list', () => {
    expect(isWorkspacePanelTerminal({})).toBe(true);
    expect(isWorkspacePanelTerminal({ surface: 'panel' })).toBe(true);
    expect(isWorkspacePanelTerminal({ surface: 'editor' })).toBe(false);
  });
});

describe('workspace terminal list pane width', () => {
  afterEach(() => {
    localStorage.removeItem(TERMINAL_LIST_PANE_STORAGE_KEY);
  });

  it('clamps the list pane so the terminal keeps a usable column', () => {
    expect(clampTerminalListPaneWidth(10, 800)).toBe(
      TERMINAL_LIST_PANE_MIN_WIDTH
    );
    expect(clampTerminalListPaneWidth(400, 800)).toBe(
      TERMINAL_LIST_PANE_MAX_WIDTH
    );
    expect(clampTerminalListPaneWidth(120, 220)).toBe(120);
    expect(clampTerminalListPaneWidth(260, 400)).toBe(240);
  });

  it('restores a stored list pane width', () => {
    localStorage.setItem(TERMINAL_LIST_PANE_STORAGE_KEY, '140');
    expect(readStoredTerminalListPaneWidth()).toBe(140);
    persistTerminalListPaneWidth(88);
    expect(localStorage.getItem(TERMINAL_LIST_PANE_STORAGE_KEY)).toBe('88');
    localStorage.setItem(TERMINAL_LIST_PANE_STORAGE_KEY, 'nope');
    expect(readStoredTerminalListPaneWidth()).toBe(
      TERMINAL_LIST_PANE_DEFAULT_WIDTH
    );
  });
});

describe('workspace terminal busy indicator', () => {
  it('marks a tab busy after a submitted command', () => {
    expect(reduceTerminalBusy(false, { type: 'input', data: 'ls\r' })).toBe(
      true
    );
  });

  it('clears busy when the shell reprints a prompt', () => {
    expect(
      reduceTerminalBusy(true, { type: 'output', data: 'file.txt\r\n% ' })
    ).toBe(false);
    expect(
      reduceTerminalBusy(true, {
        type: 'output',
        data: `${String.fromCharCode(0x1b)}]133;D${String.fromCharCode(0x07)}`,
      })
    ).toBe(false);
  });
});
