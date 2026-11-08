import { getPanelData } from 'dockview-core';

interface PendingTabPointer {
  pointerId: number;
  tabElement: HTMLElement;
  startX: number;
  startY: number;
}

interface ResolvedDropTarget {
  dropzone: HTMLElement;
  clientX: number;
  clientY: number;
}

const DRAG_START_DISTANCE_PX = 4;

function isInteractiveTabControl(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      '.dv-default-tab-action, button, [role="button"], input, textarea, select'
    )
  );
}

function createSyntheticDragEvent(
  type: string,
  clientX: number,
  clientY: number
): DragEvent {
  let event: DragEvent;
  if (typeof DragEvent === 'function') {
    event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    });
  } else {
    event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    }) as unknown as DragEvent;
  }

  if (event.clientX !== clientX) {
    Object.defineProperty(event, 'clientX', { value: clientX });
  }
  if (event.clientY !== clientY) {
    Object.defineProperty(event, 'clientY', { value: clientY });
  }
  return event;
}

function createTabDragGhost(
  tabElement: HTMLElement,
  clientX: number,
  clientY: number
): HTMLElement {
  const ghost = tabElement.cloneNode(true) as HTMLElement;
  const computed = window.getComputedStyle(tabElement);
  const rect = tabElement.getBoundingClientRect();

  ghost.classList.remove('dv-drop-target');
  ghost.querySelectorAll('.dv-drop-target-dropzone').forEach((node) => {
    node.remove();
  });

  ghost.setAttribute('data-dockview-tab-drag-ghost', 'true');
  ghost.style.position = 'fixed';
  ghost.style.left = `${Math.round(clientX + 10)}px`;
  ghost.style.top = `${Math.round(clientY + 10)}px`;
  if (rect.width > 0) {
    ghost.style.width = `${Math.round(rect.width)}px`;
  }
  if (rect.height > 0) {
    ghost.style.height = `${Math.round(rect.height)}px`;
  }
  ghost.style.margin = '0';
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '100000';
  ghost.style.opacity = '0.92';
  ghost.style.display = 'flex';
  ghost.style.alignItems = 'center';
  ghost.style.fontFamily = computed.fontFamily;
  ghost.style.fontSize = computed.fontSize;
  ghost.style.color = computed.color || 'var(--text-strong)';
  ghost.style.backgroundColor =
    'var(--surface-dialog, var(--surface-card-strong, #1f2430))';
  ghost.style.borderRadius = 'var(--radius, 6px)';
  ghost.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.28)';

  document.body.appendChild(ghost);
  return ghost;
}

function updateTabDragGhostPosition(
  ghost: HTMLElement | null,
  clientX: number,
  clientY: number
): void {
  if (!ghost) return;
  ghost.style.left = `${Math.round(clientX + 10)}px`;
  ghost.style.top = `${Math.round(clientY + 10)}px`;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function resolveDropTargetAtPoint(
  rootElement: HTMLElement,
  clientX: number,
  clientY: number,
  fallbackTarget?: EventTarget | null
): ResolvedDropTarget | null {
  const fromPoint =
    typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(clientX, clientY)
      : null;
  const hit =
    fromPoint ?? (fallbackTarget instanceof Element ? fallbackTarget : null);

  if (!hit || !rootElement.contains(hit)) {
    return null;
  }

  const tab = hit.closest('.dv-tab');
  if (
    tab instanceof HTMLElement &&
    rootElement.contains(tab) &&
    !tab.closest('.dv-tabs-overflow-container')
  ) {
    return {
      dropzone: tab,
      clientX,
      clientY,
    };
  }

  const header = hit.closest('.dv-tabs-and-actions-container');
  if (
    header instanceof HTMLElement &&
    rootElement.contains(header) &&
    !header.closest('.dv-header-hidden')
  ) {
    const tabs = Array.from(
      header.querySelectorAll<HTMLElement>('.dv-tabs-container > .dv-tab')
    );

    if (hit.closest('.dv-tabs-container, .dv-scrollable') && tabs.length > 0) {
      for (const candidate of tabs) {
        const rect = candidate.getBoundingClientRect();
        if (
          rect.width > 0 &&
          clientX >= rect.left - 6 &&
          clientX <= rect.right + 6
        ) {
          return {
            dropzone: candidate,
            clientX: clamp(clientX, rect.left + 1, rect.right - 1),
            clientY: rect.height > 0 ? rect.top + rect.height / 2 : clientY,
          };
        }
      }
    }

    const voidContainer = header.querySelector<HTMLElement>(
      ':scope > .dv-void-container'
    );
    if (voidContainer) {
      const rect = voidContainer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return {
          dropzone: voidContainer,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        };
      }
      if (tabs.length > 0) {
        const lastTab = tabs[tabs.length - 1];
        const lastRect = lastTab.getBoundingClientRect();
        if (lastRect.width > 0 && lastRect.height > 0) {
          return {
            dropzone: voidContainer,
            clientX,
            clientY,
          };
        }
      }
      return {
        dropzone: voidContainer,
        clientX,
        clientY,
      };
    }
  }

  const renderOverlay = hit.closest('.dv-render-overlay');
  if (
    renderOverlay instanceof HTMLElement &&
    rootElement.contains(renderOverlay)
  ) {
    return {
      dropzone: renderOverlay,
      clientX,
      clientY,
    };
  }

  const contentContainer = hit.closest('.dv-content-container');
  if (
    contentContainer instanceof HTMLElement &&
    rootElement.contains(contentContainer)
  ) {
    return {
      dropzone: contentContainer,
      clientX,
      clientY,
    };
  }

  return null;
}

/**
 * Bridges Dockview tab drag-and-drop onto pointer events so Windows WebView2
 * (`wry`'s native `DragDropController`, which sets `DROPEFFECT_NONE` / `no-drop`
 * for non-file HTML5 drags) never hijacks internal tab drags, while keeping
 * Dockview's own `LocalSelectionTransfer` and `Droptarget` pipeline intact.
 */
export function installDockviewPointerTabDnd(rootElement: HTMLElement): {
  dispose: () => void;
} {
  let pending: PendingTabPointer | null = null;
  let activeSourceTab: HTMLElement | null = null;
  let currentDropzone: HTMLElement | null = null;
  let lastResolved: ResolvedDropTarget | null = null;
  let ghostElement: HTMLElement | null = null;
  let previousBodyCursor = '';
  let isDispatchingSyntheticDragStart = false;

  const clearCurrentDropzone = (clientX: number, clientY: number) => {
    if (currentDropzone) {
      const target = currentDropzone;
      currentDropzone = null;
      lastResolved = null;
      target.dispatchEvent(
        createSyntheticDragEvent('dragleave', clientX, clientY)
      );
    }
  };

  const updateHoveredDropTarget = (
    clientX: number,
    clientY: number,
    fallbackTarget?: EventTarget | null
  ) => {
    const resolved = resolveDropTargetAtPoint(
      rootElement,
      clientX,
      clientY,
      fallbackTarget
    );

    if (resolved?.dropzone !== currentDropzone) {
      clearCurrentDropzone(clientX, clientY);
      if (resolved) {
        currentDropzone = resolved.dropzone;
        currentDropzone.dispatchEvent(
          createSyntheticDragEvent(
            'dragenter',
            resolved.clientX,
            resolved.clientY
          )
        );
      }
    }

    if (resolved && currentDropzone) {
      lastResolved = resolved;
      currentDropzone.dispatchEvent(
        createSyntheticDragEvent('dragover', resolved.clientX, resolved.clientY)
      );
    }
  };

  const endActiveDragSession = (
    clientX: number,
    clientY: number,
    commitDrop: boolean,
    fallbackTarget?: EventTarget | null
  ) => {
    const sourceTab = activeSourceTab;
    activeSourceTab = null;
    pending = null;

    window.removeEventListener('pointermove', handleWindowPointerMove, true);
    window.removeEventListener('pointerup', handleWindowPointerUp, true);
    window.removeEventListener(
      'pointercancel',
      handleWindowPointerCancel,
      true
    );
    window.removeEventListener('keydown', handleWindowKeyDown, true);
    window.removeEventListener('blur', handleWindowBlur);

    if (ghostElement) {
      ghostElement.remove();
      ghostElement = null;
    }
    document.body.style.cursor = previousBodyCursor;

    if (commitDrop) {
      updateHoveredDropTarget(clientX, clientY, fallbackTarget);
      if (currentDropzone && lastResolved) {
        const dropTarget = currentDropzone;
        const dropX = lastResolved.clientX;
        const dropY = lastResolved.clientY;
        currentDropzone = null;
        lastResolved = null;
        dropTarget.dispatchEvent(
          createSyntheticDragEvent('drop', dropX, dropY)
        );
      }
    } else {
      clearCurrentDropzone(clientX, clientY);
    }

    clearCurrentDropzone(clientX, clientY);

    if (sourceTab) {
      sourceTab.dispatchEvent(
        createSyntheticDragEvent('dragend', clientX, clientY)
      );
    }
  };

  const beginActiveDragSession = (
    tabElement: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    if (activeSourceTab) return;
    activeSourceTab = tabElement;
    previousBodyCursor = document.body.style.cursor;
    document.body.style.cursor = 'grabbing';
    ghostElement = createTabDragGhost(tabElement, clientX, clientY);

    window.addEventListener('pointermove', handleWindowPointerMove, true);
    window.addEventListener('pointerup', handleWindowPointerUp, true);
    window.addEventListener('pointercancel', handleWindowPointerCancel, true);
    window.addEventListener('keydown', handleWindowKeyDown, true);
    window.addEventListener('blur', handleWindowBlur);

    updateHoveredDropTarget(clientX, clientY, tabElement);
  };

  const handleWindowPointerMove = (event: PointerEvent) => {
    if (activeSourceTab) {
      event.preventDefault();
      updateTabDragGhostPosition(ghostElement, event.clientX, event.clientY);
      updateHoveredDropTarget(event.clientX, event.clientY, event.target);
      return;
    }

    if (!pending || event.pointerId !== pending.pointerId) return;
    if ((event.buttons & 1) === 0) {
      pending = null;
      window.removeEventListener('pointermove', handleWindowPointerMove, true);
      window.removeEventListener('pointerup', handleWindowPointerUp, true);
      window.removeEventListener(
        'pointercancel',
        handleWindowPointerCancel,
        true
      );
      return;
    }

    const dx = event.clientX - pending.startX;
    const dy = event.clientY - pending.startY;
    if (Math.hypot(dx, dy) < DRAG_START_DISTANCE_PX) {
      return;
    }

    const tabElement = pending.tabElement;
    isDispatchingSyntheticDragStart = true;
    try {
      tabElement.dispatchEvent(
        createSyntheticDragEvent('dragstart', event.clientX, event.clientY)
      );
    } finally {
      isDispatchingSyntheticDragStart = false;
    }
  };

  const handleWindowPointerUp = (event: PointerEvent) => {
    if (activeSourceTab) {
      event.preventDefault();
      endActiveDragSession(event.clientX, event.clientY, true, event.target);
      return;
    }
    pending = null;
    window.removeEventListener('pointermove', handleWindowPointerMove, true);
    window.removeEventListener('pointerup', handleWindowPointerUp, true);
    window.removeEventListener(
      'pointercancel',
      handleWindowPointerCancel,
      true
    );
  };

  const handleWindowPointerCancel = (event: PointerEvent) => {
    if (activeSourceTab) {
      endActiveDragSession(event.clientX, event.clientY, false, event.target);
      return;
    }
    pending = null;
    window.removeEventListener('pointermove', handleWindowPointerMove, true);
    window.removeEventListener('pointerup', handleWindowPointerUp, true);
    window.removeEventListener(
      'pointercancel',
      handleWindowPointerCancel,
      true
    );
  };

  const handleWindowKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && activeSourceTab) {
      event.preventDefault();
      endActiveDragSession(0, 0, false);
    }
  };

  const handleWindowBlur = () => {
    if (activeSourceTab) {
      endActiveDragSession(0, 0, false);
    }
  };

  const handleRootPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.shiftKey || event.defaultPrevented) {
      return;
    }
    if (isInteractiveTabControl(event.target)) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const tabElement = target?.closest('.dv-tab');
    if (
      !(tabElement instanceof HTMLElement) ||
      !rootElement.contains(tabElement) ||
      tabElement.closest('.dv-tabs-overflow-container')
    ) {
      return;
    }

    pending = {
      pointerId: event.pointerId,
      tabElement,
      startX: event.clientX,
      startY: event.clientY,
    };

    window.addEventListener('pointermove', handleWindowPointerMove, true);
    window.addEventListener('pointerup', handleWindowPointerUp, true);
    window.addEventListener('pointercancel', handleWindowPointerCancel, true);
  };

  const handleRootDragStart = (event: DragEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const tabElement = target?.closest('.dv-tab');
    if (
      !(tabElement instanceof HTMLElement) ||
      !rootElement.contains(tabElement) ||
      tabElement.closest('.dv-tabs-overflow-container')
    ) {
      return;
    }

    const panelData = getPanelData();
    if (!panelData) {
      return;
    }

    const shouldBridgeWithPointer =
      isDispatchingSyntheticDragStart ||
      pending?.tabElement === tabElement ||
      event.isTrusted;
    if (!shouldBridgeWithPointer) {
      return;
    }

    // Prevent WebView2's native OLE DoDragDrop loop (which wry turns into a
    // prohibited no-drop cursor on Windows) AFTER Dockview's TabDragHandler
    // has already populated LocalSelectionTransfer.
    event.preventDefault();

    const startX = event.clientX || pending?.startX || 0;
    const startY = event.clientY || pending?.startY || 0;
    beginActiveDragSession(tabElement, startX, startY);
  };

  rootElement.addEventListener('pointerdown', handleRootPointerDown, true);
  rootElement.addEventListener('dragstart', handleRootDragStart, false);

  return {
    dispose: () => {
      if (activeSourceTab) {
        endActiveDragSession(0, 0, false);
      }
      pending = null;
      window.removeEventListener('pointermove', handleWindowPointerMove, true);
      window.removeEventListener('pointerup', handleWindowPointerUp, true);
      window.removeEventListener(
        'pointercancel',
        handleWindowPointerCancel,
        true
      );
      window.removeEventListener('keydown', handleWindowKeyDown, true);
      window.removeEventListener('blur', handleWindowBlur);
      rootElement.removeEventListener(
        'pointerdown',
        handleRootPointerDown,
        true
      );
      rootElement.removeEventListener('dragstart', handleRootDragStart, false);
    },
  };
}
