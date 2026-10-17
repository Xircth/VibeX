const SUMMARY_LABEL_SELECTOR = [
  ".vibex-tool-call-batch > [role='button'] > span:nth-child(2)",
  '.conv-activity-header > span',
].join(', ');

const MARQUEE_SPEED_PX_PER_SECOND = 36;
const MARQUEE_MIN_MS = 800;
const MARQUEE_MAX_MS = 8000;

const marqueeAnimations = new WeakMap<HTMLElement, Animation>();

export function summaryMarqueeDurationMs(overflowPx: number): number {
  if (overflowPx <= 1) return 0;
  const duration = (overflowPx / MARQUEE_SPEED_PX_PER_SECOND) * 1000;
  return Math.round(
    Math.min(MARQUEE_MAX_MS, Math.max(MARQUEE_MIN_MS, duration))
  );
}

export function conversationSummaryLabel(
  target: EventTarget | null
): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const batchHeader = target.closest(
    ".vibex-tool-call-batch > [role='button']"
  );
  if (batchHeader) {
    const label = batchHeader.querySelector(':scope > span:nth-child(2)');
    return label instanceof HTMLElement ? label : null;
  }
  const activityHeader = target.closest('.conv-activity-header');
  if (!activityHeader) return null;
  const label = activityHeader.querySelector(':scope > span');
  return label instanceof HTMLElement ? label : null;
}

export function measureSummaryOverflow(label: HTMLElement): number {
  const text = label.textContent ?? '';
  if (text.length === 0) return 0;
  const view = label.ownerDocument.defaultView;
  if (!view) return 0;
  const computed = view.getComputedStyle(label);
  const probe = label.ownerDocument.createElement('span');
  probe.textContent = text;
  probe.setAttribute('aria-hidden', 'true');
  probe.style.position = 'fixed';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'nowrap';
  probe.style.font = computed.font;
  probe.style.letterSpacing = computed.letterSpacing;
  probe.style.wordSpacing = computed.wordSpacing;
  const host = label.ownerDocument.body ?? label;
  host.appendChild(probe);
  const textWidth = probe.offsetWidth;
  probe.remove();
  const padding =
    Number.parseFloat(computed.paddingLeft) +
    Number.parseFloat(computed.paddingRight);
  const innerWidth =
    label.clientWidth - (Number.isFinite(padding) ? padding : 0);
  if (textWidth > 0) return textWidth - innerWidth;
  if (label.dataset.summaryShift && label.dataset.summaryShift !== '0px') {
    return 0;
  }
  return label.scrollWidth - label.clientWidth;
}

function prefersReducedMarquee(label: HTMLElement): boolean {
  return (
    label.ownerDocument.defaultView?.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches ?? false
  );
}

function shiftText(label: HTMLElement, overflowPx: number, motion: boolean) {
  const shift = overflowPx > 1 ? Math.ceil(overflowPx) : 0;
  label.classList.toggle('is-overflow', shift > 0);
  const target = shift > 0 ? `-${shift}px` : '0px';
  if (label.dataset.summaryShift === target) return;
  label.dataset.summaryShift = target;
  const current = marqueeAnimations.get(label);
  if (!motion || typeof label.animate !== 'function') {
    current?.cancel();
    marqueeAnimations.delete(label);
    label.style.textIndent = shift > 0 ? target : '';
    return;
  }
  const from = label.ownerDocument.defaultView
    ? label.ownerDocument.defaultView.getComputedStyle(label).textIndent
    : '0px';
  current?.cancel();
  if (shift === 0 && (from === '0px' || from === '0')) {
    label.style.textIndent = '';
    marqueeAnimations.delete(label);
    return;
  }
  const duration =
    shift === 0
      ? summaryMarqueeDurationMs(Math.abs(Number.parseFloat(from)) || 0)
      : summaryMarqueeDurationMs(shift);
  const animation = label.animate(
    [{ textIndent: from }, { textIndent: target }],
    {
      duration: duration || MARQUEE_MIN_MS,
      easing: 'linear',
      fill: 'forwards',
    }
  );
  marqueeAnimations.set(label, animation);
  animation.onfinish = () => {
    if (marqueeAnimations.get(label) !== animation) return;
    if (target === '0px') {
      label.style.textIndent = '';
      marqueeAnimations.delete(label);
    }
  };
}

function syncOverflowMarker(label: HTMLElement): number {
  const overflow = measureSummaryOverflow(label);
  label.classList.toggle('is-overflow', overflow > 1);
  return overflow;
}

export function bindConversationSummaryMarquee(root: HTMLElement): () => void {
  const labels = new Set<HTMLElement>();
  let active: HTMLElement | null = null;

  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const label = entry.target;
      if (!(label instanceof HTMLElement) || !labels.has(label)) continue;
      const overflow = syncOverflowMarker(label);
      if (label === active) {
        shiftText(label, overflow, !prefersReducedMarquee(label));
      }
    }
  });

  const forgetDisconnected = () => {
    for (const label of labels) {
      if (label.isConnected) continue;
      labels.delete(label);
      resize.unobserve(label);
      marqueeAnimations.get(label)?.cancel();
      marqueeAnimations.delete(label);
      if (active === label) active = null;
    }
  };

  const watch = (label: HTMLElement) => {
    if (labels.has(label)) return;
    labels.add(label);
    resize.observe(label);
    syncOverflowMarker(label);
  };

  const scan = () => {
    forgetDisconnected();
    root.querySelectorAll(SUMMARY_LABEL_SELECTOR).forEach((node) => {
      if (node instanceof HTMLElement) watch(node);
    });
  };

  const syncLabel = (label: HTMLElement) => {
    const overflow = syncOverflowMarker(label);
    if (label === active) {
      shiftText(label, overflow, !prefersReducedMarquee(label));
    }
  };

  const play = (target: EventTarget | null) => {
    const label = conversationSummaryLabel(target);
    if (!label || !root.contains(label) || active === label) return;
    if (active) shiftText(active, 0, !prefersReducedMarquee(active));
    active = label;
    watch(label);
    const overflow = syncOverflowMarker(label);
    shiftText(label, overflow, !prefersReducedMarquee(label));
  };

  const stop = (target: EventTarget | null, next: EventTarget | null) => {
    const label = conversationSummaryLabel(target);
    if (!label || label !== active) return;
    if (conversationSummaryLabel(next) === label) return;
    shiftText(label, 0, !prefersReducedMarquee(label));
    active = null;
  };

  const onOver = (event: Event) => {
    play(event.target);
  };
  const onOut = (event: Event) => {
    const next =
      event instanceof FocusEvent || event instanceof PointerEvent
        ? event.relatedTarget
        : null;
    stop(event.target, next);
  };

  let scanFrame = 0;
  const scheduleScan = () => {
    if (scanFrame !== 0) return;
    const view = root.ownerDocument.defaultView;
    if (!view) {
      scan();
      return;
    }
    scanFrame = view.requestAnimationFrame(() => {
      scanFrame = 0;
      scan();
    });
  };

  scan();
  const mutations = new MutationObserver((records) => {
    let structureChanged = false;
    for (const record of records) {
      if (record.type === 'childList') {
        structureChanged = true;
        if (record.target instanceof HTMLElement && labels.has(record.target)) {
          syncLabel(record.target);
        }
        continue;
      }
      const parent = record.target.parentElement;
      if (parent && labels.has(parent)) syncLabel(parent);
    }
    if (structureChanged) scheduleScan();
  });
  mutations.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('focusin', onOver);
  root.addEventListener('focusout', onOut);

  return () => {
    mutations.disconnect();
    resize.disconnect();
    if (scanFrame !== 0) {
      root.ownerDocument.defaultView?.cancelAnimationFrame(scanFrame);
    }
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerout', onOut);
    root.removeEventListener('focusin', onOver);
    root.removeEventListener('focusout', onOut);
    for (const label of labels) {
      marqueeAnimations.get(label)?.cancel();
      marqueeAnimations.delete(label);
    }
    labels.clear();
    active = null;
  };
}
