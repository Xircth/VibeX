import { describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { EDITOR_GROUP_PREFIX, GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';
import type { LayoutArrangement } from '@/lib/layoutArrangement';
import {
  findCanvasBoundarySash,
  measureCanvasStageInsets,
} from './canvasStageInsets';

function mockRect(el: HTMLElement, rect: { left: number; width: number; height?: number }) {
  const height = rect.height ?? 800;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: 0,
    left: rect.left,
    top: 0,
    right: rect.left + rect.width,
    bottom: height,
    width: rect.width,
    height,
    toJSON: () => ({}),
  } as DOMRect);
}

const DEFAULT_ARRANGEMENT: LayoutArrangement = {
  left: 'dock',
  center: 'workspace',
  right: 'session',
  bottom: 'terminal',
};

const RIGHT_DOCK_ARRANGEMENT: LayoutArrangement = {
  left: 'session',
  center: 'workspace',
  right: 'dock',
  bottom: 'terminal',
};

describe('canvasStageInsets', () => {
  it('synchronizes left inset and canvas width live when Zone A is on the left', () => {
    const host = document.createElement('div');
    mockRect(host, { left: 48, width: 1400 });

    const leftView = document.createElement('div');
    const leftEl = document.createElement('div');
    leftEl.setAttribute('data-left-dock', 'true');
    leftView.appendChild(leftEl);
    host.appendChild(leftView);

    const editorView = document.createElement('div');
    const editorEl = document.createElement('div');
    editorView.appendChild(editorEl);
    host.appendChild(editorView);

    mockRect(leftView, { left: 48, width: 280 });
    mockRect(editorEl, { left: 328, width: 1120 });

    const api = {
      groups: [
        {
          id: GROUP_IDS.LEFT,
          element: leftEl,
          panels: [{ id: PANEL_IDS.SESSION_LIST }],
          api: { isVisible: true, width: 280 },
        },
        {
          id: `${EDITOR_GROUP_PREFIX}1`,
          element: editorEl,
          panels: [{ id: PANEL_IDS.WELCOME }],
          api: { isVisible: true, width: 1120 },
        },
      ],
    } as unknown as Pick<DockviewApi, 'groups'>;

    expect(measureCanvasStageInsets(api, host, DEFAULT_ARRANGEMENT)).toEqual({
      left: 280,
      right: 0,
    });

    // Simulate live sash drag resizing Zone A from 280 -> 410
    mockRect(leftView, { left: 48, width: 410 });
    mockRect(editorEl, { left: 458, width: 990 });

    expect(measureCanvasStageInsets(api, host, DEFAULT_ARRANGEMENT)).toEqual({
      left: 410,
      right: 0,
    });
  });

  it('synchronizes right inset and canvas width live when Zone A is docked on the right', () => {
    const host = document.createElement('div');
    mockRect(host, { left: 0, width: 1400 });

    const editorView = document.createElement('div');
    const editorEl = document.createElement('div');
    editorView.appendChild(editorEl);
    host.appendChild(editorView);

    const rightDockView = document.createElement('div');
    const rightDockEl = document.createElement('div');
    rightDockEl.setAttribute('data-left-dock', 'true');
    rightDockEl.setAttribute('data-shell-nav-side', 'right');
    rightDockView.appendChild(rightDockEl);
    host.appendChild(rightDockView);

    mockRect(editorEl, { left: 0, width: 1080 });
    mockRect(rightDockView, { left: 1080, width: 320 });

    const api = {
      groups: [
        {
          id: `${EDITOR_GROUP_PREFIX}1`,
          element: editorEl,
          panels: [{ id: PANEL_IDS.WELCOME }],
          api: { isVisible: true, width: 1080 },
        },
        {
          id: `${GROUP_IDS.LEFT}-right`,
          element: rightDockEl,
          panels: [{ id: PANEL_IDS.FILE_TREE }],
          api: { isVisible: true, width: 320 },
        },
      ],
    } as unknown as Pick<DockviewApi, 'groups'>;

    expect(measureCanvasStageInsets(api, host, RIGHT_DOCK_ARRANGEMENT)).toEqual({
      left: 0,
      right: 320,
    });

    // Simulate live sash drag widening right Zone A from 320 -> 460
    mockRect(editorEl, { left: 0, width: 940 });
    mockRect(rightDockView, { left: 940, width: 460 });

    expect(measureCanvasStageInsets(api, host, RIGHT_DOCK_ARRANGEMENT)).toEqual({
      left: 0,
      right: 460,
    });
  });

  it('finds the adjacent Dockview sash on both left and right canvas boundaries', () => {
    const host = document.createElement('div');
    mockRect(host, { left: 48, width: 1400 });

    const leftSash = document.createElement('div');
    leftSash.className = 'dv-sash';
    mockRect(leftSash, { left: 326, width: 4, height: 800 });
    host.appendChild(leftSash);

    const rightSash = document.createElement('div');
    rightSash.className = 'dv-sash';
    mockRect(rightSash, { left: 1126, width: 4, height: 800 });
    host.appendChild(rightSash);

    expect(
      findCanvasBoundarySash(host, { left: 280, right: 320 }, 'left')
    ).toBe(leftSash);
    expect(
      findCanvasBoundarySash(host, { left: 280, right: 320 }, 'right')
    ).toBe(rightSash);
  });

  it('covers the entire Zone B stage and does not expose legacy right AI Chat session groups alongside Infinite Canvas', () => {
    const host = document.createElement('div');
    mockRect(host, { left: 48, width: 1400 });

    const leftView = document.createElement('div');
    const leftEl = document.createElement('div');
    leftEl.setAttribute('data-left-dock', 'true');
    leftView.appendChild(leftEl);
    host.appendChild(leftView);

    const editorView = document.createElement('div');
    const editorEl = document.createElement('div');
    editorView.appendChild(editorEl);
    host.appendChild(editorView);

    const rightSessionView = document.createElement('div');
    const rightSessionEl = document.createElement('div');
    rightSessionEl.setAttribute('data-session-dock', 'true');
    rightSessionView.appendChild(rightSessionEl);
    host.appendChild(rightSessionView);

    mockRect(leftView, { left: 48, width: 260 });
    mockRect(editorEl, { left: 308, width: 706 });
    mockRect(rightSessionView, { left: 1014, width: 434 });

    const api = {
      groups: [
        {
          id: GROUP_IDS.LEFT,
          element: leftEl,
          panels: [{ id: PANEL_IDS.FILE_TREE }],
          api: { isVisible: true, width: 260 },
        },
        {
          id: `${EDITOR_GROUP_PREFIX}1`,
          element: editorEl,
          panels: [{ id: PANEL_IDS.WELCOME }],
          api: { isVisible: true, width: 706 },
        },
        {
          id: GROUP_IDS.RIGHT,
          element: rightSessionEl,
          panels: [{ id: PANEL_IDS.AI_CHAT }],
          api: { isVisible: true, width: 434 },
        },
      ],
    } as unknown as Pick<DockviewApi, 'groups'>;

    expect(measureCanvasStageInsets(api, host, DEFAULT_ARRANGEMENT)).toEqual({
      left: 260,
      right: 0,
    });
  });
});
