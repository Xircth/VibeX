// Pure helpers (no DOM globals at import time) so they can be unit tested.

export const PLUGIN_ID = 'vibex.tauri-ui-debugger';

export const CONTENT_LEVELS = [
  '源码位置',
  '源码位置 + 组件链',
  '源码位置 + 组件链 + 关键样式',
];

export const DEFAULT_CONFIG = Object.freeze({
  showBall: true,
  ballPosition: '左下角',
  shortcut: 'Alt+Shift+C',
  insertContent: '源码位置 + 组件链',
  keepSelecting: false,
});

const POSITIONS = ['左下角', '右下角'];
const SHORTCUTS = ['Alt+Shift+C', 'Ctrl+Shift+X', '关闭'];

export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    showBall:
      typeof r.showBall === 'boolean' ? r.showBall : DEFAULT_CONFIG.showBall,
    ballPosition: POSITIONS.includes(r.ballPosition)
      ? r.ballPosition
      : DEFAULT_CONFIG.ballPosition,
    shortcut: SHORTCUTS.includes(r.shortcut)
      ? r.shortcut
      : DEFAULT_CONFIG.shortcut,
    insertContent: CONTENT_LEVELS.includes(r.insertContent)
      ? r.insertContent
      : DEFAULT_CONFIG.insertContent,
    keepSelecting:
      typeof r.keepSelecting === 'boolean'
        ? r.keepSelecting
        : DEFAULT_CONFIG.keepSelecting,
  };
}

export function contentLevel(config) {
  return Math.max(0, CONTENT_LEVELS.indexOf(config.insertContent)) + 1;
}

export function positionToCorner(position) {
  return position === '右下角' ? 'bottom-right' : 'bottom-left';
}

export function cornerToPosition(corner) {
  if (corner === 'bottom-right') return '右下角';
  if (corner === 'bottom-left') return '左下角';
  return null;
}

export function isMacPlatform(nav) {
  const platform =
    nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '';
  return /mac|iphone|ipad/i.test(platform);
}

/** Display text for a shortcut preset. */
export function formatShortcut(shortcut, mac) {
  if (shortcut === '关闭') return '';
  if (!mac) return shortcut;
  return shortcut
    .replace('Alt+', '⌥')
    .replace('Ctrl+', '⌘')
    .replace('Shift+', '⇧');
}

/** Whether a KeyboardEvent-like object matches a preset. On macOS `Ctrl` in
 * the preset means ⌘. */
export function matchesShortcut(event, shortcut, mac) {
  if (!shortcut || shortcut === '关闭') return false;
  const code = event.code || '';
  if (shortcut === 'Alt+Shift+C') {
    return (
      event.altKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      code === 'KeyC'
    );
  }
  if (shortcut === 'Ctrl+Shift+X') {
    const primary = mac ? event.metaKey : event.ctrlKey;
    const other = mac ? event.ctrlKey : event.metaKey;
    return primary && !other && event.shiftKey && !event.altKey && code === 'KeyX';
  }
  return false;
}

export function hintText(mac) {
  return mac
    ? '点击元素选中 · Esc 退出 · ⌥ 选父级 · ⇧ 多选 · 按住 ⌘ 点击穿透'
    : '点击元素选中 · Esc 退出 · Alt 选父级 · Shift 多选 · 按住 Ctrl 点击穿透';
}

/** "frontend/src/a/B.tsx:42:7" -> { path, line, column } */
export function parseSource(value) {
  if (!value || typeof value !== 'string') return null;
  const match = /^(.*):(\d+):(\d+)$/.exec(value.trim());
  if (!match) return { path: value.trim(), line: null, column: null };
  return { path: match[1], line: Number(match[2]), column: Number(match[3]) };
}

export function basename(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function truncate(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

/**
 * info: { tag, classes: string[], text, component, chain: string[] (inner→outer),
 *         source: "path:l:c" | null, sourceIsAncestor, selector,
 *         rect: {x,y,width,height}, styles: string }
 */
export function buildLabel(info) {
  const name = info.component
    ? `<${info.component}>`
    : `<${[info.tag, ...(info.classes ?? []).slice(0, 1)].join('.')}>`;
  const src = parseSource(info.source);
  if (!src) return name;
  return `${name} ${basename(src.path)}${src.line ? `:${src.line}` : ''}`;
}

export function buildMarkdown(info, level) {
  const tagDesc = [info.tag, ...(info.classes ?? []).slice(0, 2)].join('.');
  const text = truncate(info.text, 80);
  const lines = [
    `[UI 元素] <${tagDesc}>${text ? ` 文本: "${text}"` : ''}`,
  ];
  if (level >= 2 && info.chain?.length) {
    lines.push(`- 组件链: ${info.chain.join(' > ')}`);
  }
  lines.push(
    info.source
      ? `- 源码: ${info.source} (data-vx-source${info.sourceIsAncestor ? '，最近的带标注祖先' : ''})`
      : '- 源码: 未标注源码（仅选择器）'
  );
  if (info.selector) lines.push(`- 选择器: ${info.selector}`);
  if (info.rect) {
    const r = info.rect;
    lines.push(
      `- 尺寸: ${Math.round(r.width)}×${Math.round(r.height)} @ (${Math.round(r.x)}, ${Math.round(r.y)})`
    );
  }
  if (level >= 3 && info.styles) lines.push(`- 关键样式: ${info.styles}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// DOM runtime
// ---------------------------------------------------------------------------

const UI_ATTR = 'data-vx-debugger-ui';
const CORNER_KEY = 'vibex.tauri-ui-debugger.corner';
const CORNER_CONFIG_KEY = 'vibex.tauri-ui-debugger.corner-config';
const BALL_SIZE = 40;
const SIDE_INSET = 16;
const STATUSBAR_GAP = 12;
const BOTTOM_RIGHT_RAISE = 96;
const DRAG_THRESHOLD = 4;
const SELECT_Z = 2147483000;
const STYLE_PROPS = [
  ['display', ['inline', 'block']],
  ['position', ['static']],
  ['gap', ['normal']],
  ['padding', ['0px']],
  ['margin', ['0px']],
  ['border-radius', ['0px']],
  ['font-size', []],
  ['color', []],
  ['background-color', ['rgba(0, 0, 0, 0)', 'transparent']],
  ['border', []],
];

const CSS = `
[${UI_ATTR}] { box-sizing: border-box; font-family: inherit; }
.vx-dbg-ball {
  position: fixed; width: ${BALL_SIZE}px; height: ${BALL_SIZE}px; border-radius: 999px;
  display: flex; align-items: center; justify-content: center; padding: 0; margin: 0;
  background: var(--surface-popover, #fff); border: 1px solid var(--border-subtle, rgba(0,0,0,.12));
  color: var(--text-muted, #6b6b6b); box-shadow: 0 1px 2px rgba(0,0,0,.08);
  cursor: pointer; z-index: 40; touch-action: none; user-select: none;
  transition: color .15s, box-shadow .15s, background-color .15s, opacity .15s;
}
.vx-dbg-ball:hover { color: var(--text-strong, #111); box-shadow: var(--shadow-popover, 0 8px 24px rgba(0,0,0,.16)); }
.vx-dbg-ball:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--focus-ring, hsl(var(--primary) / .35)); }
.vx-dbg-ball[aria-pressed="true"] {
  background: hsl(var(--primary)); color: var(--primary-control-foreground, #fff);
  border-color: transparent; box-shadow: 0 0 0 3px var(--focus-ring, hsl(var(--primary) / .35));
}
.vx-dbg-ball[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.vx-dbg-ball[data-dragging="true"] { cursor: grabbing; transition: none; }
.vx-dbg-ball svg { width: 18px; height: 18px; pointer-events: none; }
.vx-dbg-tip {
  position: fixed; z-index: 41; pointer-events: none; max-width: 260px;
  background: var(--surface-popover, #fff); color: var(--text-strong, #111);
  border: 1px solid var(--border-subtle, rgba(0,0,0,.12)); border-radius: var(--radius, 10px);
  box-shadow: var(--shadow-popover, 0 8px 24px rgba(0,0,0,.16)); padding: 6px 10px;
  font-size: .75rem; line-height: 1.4;
}
.vx-dbg-tip b { font-weight: 500; display: block; }
.vx-dbg-tip span { color: var(--text-muted, #6b6b6b); }
.vx-dbg-layer { position: fixed; inset: 0; z-index: ${SELECT_Z}; pointer-events: none; }
.vx-dbg-box {
  position: fixed; pointer-events: none; outline: 2px solid hsl(var(--primary));
  background: hsl(var(--primary) / .06); border-radius: 2px; display: none;
}
.vx-dbg-box[data-variant="parent"] { outline: 1px dashed var(--text-subtle, #999); background: transparent; }
.vx-dbg-box[data-variant="picked"] { outline-style: dashed; }
.vx-dbg-box[data-flash="true"] { animation: vx-dbg-flash 180ms ease-out 2; }
@keyframes vx-dbg-flash { 50% { outline-color: transparent; background: hsl(var(--primary) / .18); } }
@media (prefers-reduced-motion: reduce) { .vx-dbg-box[data-flash="true"] { animation: none; } }
.vx-dbg-chip {
  position: fixed; pointer-events: none; display: none; white-space: nowrap;
  background: hsl(var(--primary)); color: var(--primary-control-foreground, #fff);
  border-radius: 999px; padding: 2px 8px; font-size: .75rem; font-weight: 500; line-height: 18px;
}
.vx-dbg-chip code { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 400; opacity: .9; }
.vx-dbg-hint {
  position: fixed; pointer-events: auto; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; white-space: nowrap;
  background: var(--surface-popover, #fff); color: var(--text-strong, #111);
  border: 1px solid var(--border-subtle, rgba(0,0,0,.12)); border-radius: 999px;
  box-shadow: var(--shadow-popover, 0 8px 24px rgba(0,0,0,.16));
  padding: 4px 4px 4px 14px; font-size: .75rem; line-height: 1.4;
}
.vx-dbg-hint button {
  font: inherit; border-radius: 999px; padding: 3px 10px; cursor: pointer;
  background: var(--surface-control, transparent); color: inherit;
  border: 1px solid var(--border-subtle, rgba(0,0,0,.12));
}
.vx-dbg-hint button[data-primary="true"] { background: hsl(var(--primary)); color: var(--primary-control-foreground, #fff); border-color: transparent; }
.vx-dbg-toast {
  position: fixed; right: 16px; bottom: 16px; z-index: ${SELECT_Z + 1}; pointer-events: none;
  min-width: 240px; max-width: 360px; padding: 10px 14px;
  background: var(--surface-popover, #fff); color: var(--text-strong, #111);
  border: 1px solid var(--border-subtle, rgba(0,0,0,.12)); border-radius: var(--radius, 10px);
  box-shadow: var(--shadow-popover, 0 8px 24px rgba(0,0,0,.16)); font-size: .8125rem;
}
.vx-dbg-toast b { display: block; font-weight: 500; }
.vx-dbg-toast[data-kind="success"] b::before { content: "✓ "; color: var(--success, #16a34a); }
.vx-dbg-toast[data-kind="error"] b { color: var(--destructive-text, #dc2626); }
.vx-dbg-toast span { display: block; color: var(--text-muted, #6b6b6b); font-size: .75rem; margin-top: 2px; }
.vx-dbg-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/></svg>`;

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.setAttribute(UI_ATTR, '');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function isOwnUi(node) {
  return Boolean(node?.closest?.(`[${UI_ATTR}]`));
}

function titlebarBottom() {
  let bottom = 0;
  for (const node of document.querySelectorAll('[data-tauri-drag-region]')) {
    if (isOwnUi(node)) continue;
    const r = node.getBoundingClientRect();
    if (r.top <= 4 && r.height > 0 && r.height < 80) bottom = Math.max(bottom, r.bottom);
  }
  return bottom;
}

/** Bounds of the main content area: right of a full-height left sidebar and
 * below the titlebar. Generic layout heuristic, no host specifics. */
function mainContentRect() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = 0;
  const candidates = document.querySelectorAll(
    'aside, nav, [class*="sidebar" i], [data-sidebar]'
  );
  for (const node of candidates) {
    if (isOwnUi(node)) continue;
    const r = node.getBoundingClientRect();
    if (r.left <= 1 && r.width > 40 && r.width < vw * 0.5 && r.height > vh * 0.6) {
      left = Math.max(left, r.right);
    }
  }
  return { left, right: vw, top: titlebarBottom() };
}

/** Top edge of a full-width bottom status bar, or the viewport bottom.
 * Generic layout heuristic: probes the element at the bottom edge. */
export function statusbarTop() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = vh;
  const probes = document.elementsFromPoint?.(Math.round(vw / 2), vh - 2) ?? [];
  for (const node of probes) {
    if (isOwnUi(node)) continue;
    const r = node.getBoundingClientRect();
    if (r.bottom >= vh - 1 && r.height > 0 && r.height < 60 && r.width >= vw * 0.8) {
      top = Math.min(top, r.top);
    }
  }
  return top;
}

/** The ball belongs to app windows only, not settings / desktop-toast
 * auxiliary windows. Prefers the webview window label when the runtime
 * exposes it; falls back to the auxiliary windows' route prefixes. */
export function isMainWindow({ label, pathname } = {}) {
  if (typeof label === 'string' && label) {
    return !/^(settings|desktop-toast)(-|$)/.test(label);
  }
  return !/^\/(settings|plugins|desktop-toast)(\/|$)/.test(pathname || '/');
}

function currentWindowInfo() {
  const g = globalThis;
  return {
    label: g.__TAURI_INTERNALS__?.metadata?.currentWindow?.label,
    pathname: g.location?.pathname,
  };
}

function modalOpen() {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"]:not([' + UI_ATTR + ']), [role="alertdialog"][data-state="open"], dialog[open]'
    )
  );
}

function hasSourceAnnotations() {
  return Boolean(document.querySelector('[data-vx-source]'));
}

function cssPath(node) {
  const parts = [];
  let cur = node;
  while (cur && cur.nodeType === 1 && parts.length < 4) {
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    let part = cur.tagName.toLowerCase();
    const cls = Array.from(cur.classList).find((c) => /^[A-Za-z][\w-]*$/.test(c));
    if (cls) part += `.${cls}`;
    const parent = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    if (cur.tagName === 'MAIN' || cur.tagName === 'BODY') break;
    cur = parent;
  }
  return parts.join(' > ');
}

function keyStyles(node) {
  const cs = getComputedStyle(node);
  const out = [];
  for (const [prop, defaults] of STYLE_PROPS) {
    let value = cs.getPropertyValue(prop).trim();
    if (!value || defaults.includes(value)) continue;
    if (prop === 'border' && /^0px|none/.test(value)) continue;
    if (prop === 'gap' && value === 'normal') continue;
    out.push(`${prop}:${value}`);
  }
  return out.join('; ');
}

function describe(node) {
  const annotated = node.closest('[data-vx-source]');
  const chain = [];
  let cur = node.closest('[data-vx-component]');
  while (cur && chain.length < 6) {
    const name = cur.getAttribute('data-vx-component');
    if (name && chain[chain.length - 1] !== name) chain.push(name);
    cur = cur.parentElement?.closest('[data-vx-component]') ?? null;
  }
  const rect = node.getBoundingClientRect();
  return {
    tag: node.tagName.toLowerCase(),
    classes: Array.from(node.classList).filter((c) => /^[A-Za-z][\w-]*$/.test(c)),
    text: (node.innerText || node.textContent || node.getAttribute('aria-label') || '').slice(0, 400),
    component: annotated?.getAttribute('data-vx-component') || chain[0] || null,
    chain,
    source: annotated?.getAttribute('data-vx-source') || null,
    sourceIsAncestor: Boolean(annotated && annotated !== node),
    selector: cssPath(node),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    styles: keyStyles(node),
  };
}

function createDebugger(ctx) {
  const mac = isMacPlatform(globalThis.navigator);
  let config = { ...DEFAULT_CONFIG };
  let selecting = false;
  let disabled = false;
  let hovered = null;
  let parentStack = [];
  let picked = [];
  let rafId = 0;
  let lastPoint = null;
  let toastTimer = 0;
  let tipTimer = 0;
  const disposers = [];

  const style = document.createElement('style');
  style.setAttribute(UI_ATTR, '');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = el('div', '', { style: 'position:fixed;inset:auto;z-index:40;' });
  root.id = 'vx-tauri-ui-debugger-root';
  const ball = el('button', 'vx-dbg-ball', {
    type: 'button',
    'aria-label': 'TauriUI调试器：选择元素',
    'aria-pressed': 'false',
  });
  ball.innerHTML = ICON;
  const tip = el('div', 'vx-dbg-tip');
  tip.style.display = 'none';
  const live = el('div', 'vx-dbg-sr', { 'aria-live': 'polite' });
  const layer = el('div', 'vx-dbg-layer');
  layer.style.display = 'none';
  const box = el('div', 'vx-dbg-box');
  const parentBox = el('div', 'vx-dbg-box', { 'data-variant': 'parent' });
  const chip = el('div', 'vx-dbg-chip');
  const hint = el('div', 'vx-dbg-hint', { role: 'status' });
  const hintLabel = el('span');
  const hintInsert = el('button', '', { type: 'button', 'data-primary': 'true' });
  const hintExit = el('button', '', { type: 'button' });
  hintExit.textContent = '退出';
  hint.append(hintLabel, hintInsert, hintExit);
  const pickedLayer = el('div');
  layer.append(pickedLayer, parentBox, box, chip, hint);
  const toastNode = el('div', 'vx-dbg-toast', { role: 'status' });
  toastNode.style.display = 'none';
  root.append(ball, tip, live, layer, toastNode);
  document.body.appendChild(root);

  // ---- config ------------------------------------------------------------
  async function loadConfig() {
    try {
      const raw = await ctx.settings.get();
      config = normalizeConfig(raw);
    } catch {
      config = normalizeConfig(config);
    }
    applyCorner();
    updateVisibility();
    return config;
  }

  // ---- corner / position ---------------------------------------------------
  function currentCorner() {
    const configCorner = positionToCorner(config.ballPosition);
    try {
      const lastSyncedConfig = localStorage.getItem(CORNER_CONFIG_KEY);
      const stored = localStorage.getItem(CORNER_KEY);
      // A config change made in the form wins over the last dragged corner.
      if (lastSyncedConfig !== config.ballPosition) {
        localStorage.setItem(CORNER_CONFIG_KEY, config.ballPosition);
        localStorage.setItem(CORNER_KEY, configCorner);
        return configCorner;
      }
      if (stored) return stored;
    } catch {
      /* storage unavailable */
    }
    return configCorner;
  }

  function cornerPosition(corner) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = titlebarBottom() + 8;
    switch (corner) {
      case 'top-left':
        return { x: SIDE_INSET, y: top };
      case 'top-right':
        return { x: vw - SIDE_INSET - BALL_SIZE, y: top };
      case 'bottom-right':
        return {
          x: vw - SIDE_INSET - BALL_SIZE,
          y: Math.min(vh - BOTTOM_RIGHT_RAISE, statusbarTop() - STATUSBAR_GAP) - BALL_SIZE,
        };
      default:
        return { x: SIDE_INSET, y: statusbarTop() - STATUSBAR_GAP - BALL_SIZE };
    }
  }

  function placeBall(x, y) {
    ball.style.left = `${Math.round(x)}px`;
    ball.style.top = `${Math.round(y)}px`;
  }

  function applyCorner() {
    const p = cornerPosition(currentCorner());
    placeBall(p.x, p.y);
  }

  function nearestCorner(x, y) {
    const cx = x + BALL_SIZE / 2;
    const cy = y + BALL_SIZE / 2;
    const horizontal = cx < window.innerWidth / 2 ? 'left' : 'right';
    const vertical = cy < window.innerHeight / 2 ? 'top' : 'bottom';
    return `${vertical}-${horizontal}`;
  }

  function saveCorner(corner) {
    try {
      localStorage.setItem(CORNER_KEY, corner);
    } catch {
      /* ignore */
    }
    const position = cornerToPosition(corner);
    if (position && position !== config.ballPosition) {
      config = { ...config, ballPosition: position };
      try {
        localStorage.setItem(CORNER_CONFIG_KEY, position);
      } catch {
        /* ignore */
      }
      void ctx.settings.set({ ...config }).catch(() => undefined);
    }
  }

  // ---- visibility / availability -----------------------------------------
  function updateVisibility() {
    const visible =
      config.showBall &&
      isMainWindow(currentWindowInfo()) &&
      hasSourceAnnotations() &&
      !modalOpen();
    ball.style.display = visible || selecting ? 'flex' : 'none';
    if (!visible) hideTip();
    else if (!ball.hasAttribute('data-dragging')) applyCorner();
  }

  async function refreshAvailability() {
    try {
      const res = await ctx.conversation.call('draft.target', {});
      setDisabled(res && typeof res === 'object' && res.available === false);
    } catch {
      /* host without draft.target: leave state as is */
    }
  }

  function setDisabled(value) {
    disabled = Boolean(value);
    ball.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  // ---- tooltip -------------------------------------------------------------
  function showTip() {
    const shortcut = formatShortcut(config.shortcut, mac);
    tip.innerHTML = '';
    const title = document.createElement('b');
    const sub = document.createElement('span');
    if (disabled) {
      title.textContent = '没有可写入的输入框';
      sub.textContent = '打开一个会话后再试';
    } else {
      title.textContent = `选择界面元素${shortcut ? ` ${shortcut}` : ''}`;
      sub.textContent = '点击后在窗口内选中组件';
    }
    tip.append(title, sub);
    tip.style.display = 'block';
    const r = ball.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - tr.width - 8);
    const top = r.top - tr.height - 8 < 0 ? r.bottom + 8 : r.top - tr.height - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tip.style.display = 'none';
  }

  // ---- toast ---------------------------------------------------------------
  function toast(kind, title, description) {
    clearTimeout(toastTimer);
    toastNode.innerHTML = '';
    toastNode.setAttribute('data-kind', kind);
    const b = document.createElement('b');
    b.textContent = title;
    toastNode.append(b);
    if (description) {
      const s = document.createElement('span');
      s.textContent = description;
      toastNode.append(s);
    }
    toastNode.style.display = 'block';
    live.textContent = `${title} ${description ?? ''}`;
    toastTimer = setTimeout(() => {
      toastNode.style.display = 'none';
    }, 3200);
  }

  // ---- selection mode --------------------------------------------------------
  function positionHint() {
    const area = mainContentRect();
    hint.style.left = `${Math.round((area.left + area.right) / 2)}px`;
    hint.style.top = `${Math.round(area.top + 10)}px`;
  }

  function renderHint() {
    if (picked.length > 0) {
      hintLabel.textContent = `已选 ${picked.length} 个 · Enter 插入 · Esc 清空`;
      hintInsert.textContent = `插入 ${picked.length} 项`;
      hintInsert.style.display = '';
    } else {
      hintLabel.textContent = hintText(mac);
      hintInsert.style.display = 'none';
    }
    positionHint();
  }

  function placeBox(node, target, variant) {
    if (!target) {
      node.style.display = 'none';
      return;
    }
    const r = target.getBoundingClientRect();
    node.style.display = 'block';
    node.style.left = `${r.left}px`;
    node.style.top = `${r.top}px`;
    node.style.width = `${r.width}px`;
    node.style.height = `${r.height}px`;
    if (variant) node.setAttribute('data-variant', variant);
  }

  function renderPicked() {
    pickedLayer.innerHTML = '';
    picked.forEach((target, i) => {
      const b = el('div', 'vx-dbg-box', { 'data-variant': 'picked' });
      placeBox(b, target);
      const c = el('div', 'vx-dbg-chip');
      c.textContent = String(i + 1);
      const r = target.getBoundingClientRect();
      c.style.display = 'block';
      c.style.left = `${r.left}px`;
      c.style.top = `${Math.max(0, r.top - 22)}px`;
      pickedLayer.append(b, c);
    });
  }

  function renderHover() {
    placeBox(box, hovered);
    placeBox(parentBox, null);
    if (!hovered) {
      chip.style.display = 'none';
      return;
    }
    const info = describe(hovered);
    const src = parseSource(info.source);
    chip.innerHTML = '';
    const name = document.createElement('span');
    name.textContent = info.component ?? `${info.tag}${info.classes[0] ? `.${info.classes[0]}` : ''}`;
    const meta = document.createElement('code');
    meta.textContent = ` · ${src ? `${basename(src.path)}${src.line ? `:${src.line}` : ''}` : '无源码信息'} · ${Math.round(info.rect.width)}×${Math.round(info.rect.height)}`;
    chip.append(name, meta);
    chip.style.display = 'block';
    const r = hovered.getBoundingClientRect();
    const cr = chip.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + cr.height > window.innerHeight) top = r.top - cr.height - 4;
    if (top < 0) top = r.top + 4;
    const left = Math.min(Math.max(4, r.left), window.innerWidth - cr.width - 4);
    chip.style.left = `${left}px`;
    chip.style.top = `${top}px`;
  }

  function targetAt(x, y) {
    const node = document.elementFromPoint(x, y);
    if (!node || isOwnUi(node) || node === document.documentElement) return null;
    return node;
  }

  function onPointerMove(event) {
    if (!selecting) return;
    lastPoint = { x: event.clientX, y: event.clientY };
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!lastPoint) return;
      const next = targetAt(lastPoint.x, lastPoint.y);
      if (next !== hovered) {
        hovered = next;
        parentStack = [];
        renderHover();
      }
    });
  }

  function passThrough(event) {
    return mac ? event.metaKey : event.ctrlKey;
  }

  function swallow(event) {
    if (!selecting) return;
    if (isOwnUi(event.target)) return;
    if (passThrough(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function onClick(event) {
    if (!selecting) return;
    if (isOwnUi(event.target)) return;
    if (passThrough(event)) return;
    swallow(event);
    const target = hovered ?? targetAt(event.clientX, event.clientY);
    if (!target) return;
    if (event.shiftKey) {
      const index = picked.indexOf(target);
      if (index >= 0) picked.splice(index, 1);
      else picked.push(target);
      renderPicked();
      renderHint();
      return;
    }
    void commit([target]);
  }

  async function commit(targets) {
    if (!targets.length) return;
    const level = contentLevel(config);
    let insertedAll = true;
    const labels = [];
    const fallback = [];
    for (const target of targets) {
      const info = describe(target);
      const token = { label: buildLabel(info), markdown: buildMarkdown(info, level) };
      fallback.push(token.markdown);
      labels.push(`${info.component ?? info.tag}${info.source ? ` · ${basename(parseSource(info.source).path)}${parseSource(info.source).line ? `:${parseSource(info.source).line}` : ''}` : ''}`);
      let inserted = false;
      try {
        const res = await ctx.conversation.call('draft.insert', { token });
        inserted = !(res && typeof res === 'object' && res.inserted === false);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        insertedAll = false;
        break;
      }
      flash(target);
    }
    picked = [];
    renderPicked();
    if (!insertedAll) {
      setDisabled(true);
      try {
        await navigator.clipboard?.writeText(fallback.join('\n\n'));
      } catch {
        /* ignore */
      }
      exitSelection();
      toast('error', '没有可写入的输入框', '请先打开一个会话或聚焦输入框，选中内容已复制到剪贴板。');
      return;
    }
    setDisabled(false);
    toast('success', '已插入到输入框', labels.join('，'));
    if (!config.keepSelecting) exitSelection();
    else renderHint();
  }

  function flash(target) {
    const f = el('div', 'vx-dbg-box', { 'data-flash': 'true' });
    placeBox(f, target);
    layer.style.display = 'block';
    root.appendChild(f);
    f.style.zIndex = String(SELECT_Z);
    setTimeout(() => f.remove(), 400);
  }

  function onKeyDown(event) {
    if (!selecting && matchesShortcut(event, config.shortcut, mac)) {
      event.preventDefault();
      void enterSelection();
      return;
    }
    if (!selecting) return;
    if (matchesShortcut(event, config.shortcut, mac)) {
      event.preventDefault();
      exitSelection();
      return;
    }
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (picked.length) {
        picked = [];
        renderPicked();
        renderHint();
      } else exitSelection();
      return;
    }
    if ((key === 'Alt' || key === 'ArrowUp') && hovered) {
      event.preventDefault();
      const parent = hovered.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        parentStack.push(hovered);
        hovered = parent;
        renderHover();
      }
      return;
    }
    if (key === 'ArrowDown' && parentStack.length) {
      event.preventDefault();
      hovered = parentStack.pop();
      renderHover();
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (picked.length) void commit([...picked]);
      else if (hovered) void commit([hovered]);
    }
  }

  function onScrollOrResize() {
    applyCorner();
    if (!selecting) return;
    renderHover();
    renderPicked();
    positionHint();
  }

  async function enterSelection() {
    if (selecting) return;
    await loadConfig(); // fresh config every time
    await refreshAvailability();
    if (disabled) {
      toast('error', '没有可写入的输入框', '请先打开一个会话或聚焦输入框。');
      return;
    }
    selecting = true;
    hideTip();
    ball.setAttribute('aria-pressed', 'true');
    layer.style.display = 'block';
    document.documentElement.style.cursor = 'crosshair';
    renderHint();
    live.textContent = '已进入元素选择模式，按 Esc 退出';
  }

  function exitSelection() {
    if (!selecting) return;
    selecting = false;
    hovered = null;
    parentStack = [];
    picked = [];
    renderPicked();
    ball.setAttribute('aria-pressed', 'false');
    layer.style.display = 'none';
    box.style.display = 'none';
    chip.style.display = 'none';
    document.documentElement.style.cursor = '';
    live.textContent = '已退出元素选择模式';
    updateVisibility();
  }

  // ---- ball interactions -----------------------------------------------------
  let drag = null;
  ball.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const r = ball.getBoundingClientRect();
    drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: r.left, oy: r.top, moved: false };
    ball.setPointerCapture?.(event.pointerId);
  });
  ball.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      drag.moved = true;
      ball.setAttribute('data-dragging', 'true');
      hideTip();
    }
    if (drag.moved) {
      const x = Math.min(Math.max(0, drag.ox + dx), window.innerWidth - BALL_SIZE);
      const y = Math.min(Math.max(0, drag.oy + dy), window.innerHeight - BALL_SIZE);
      placeBall(x, y);
    }
  });
  const endDrag = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const wasDrag = drag.moved;
    drag = null;
    ball.removeAttribute('data-dragging');
    if (wasDrag) {
      const r = ball.getBoundingClientRect();
      const corner = nearestCorner(r.left, r.top);
      saveCorner(corner);
      const p = cornerPosition(corner);
      placeBall(p.x, p.y);
      ball.dataset.suppressClick = 'true';
    }
  };
  ball.addEventListener('pointerup', endDrag);
  ball.addEventListener('pointercancel', endDrag);
  ball.addEventListener('click', (event) => {
    event.preventDefault();
    if (ball.dataset.suppressClick) {
      delete ball.dataset.suppressClick;
      return;
    }
    if (selecting) exitSelection();
    else if (!disabled) void enterSelection();
    else void refreshAvailability().then(() => {
      if (!disabled) void enterSelection();
      else toast('error', '没有可写入的输入框', '打开一个会话后再试');
    });
  });
  ball.addEventListener('pointerenter', () => {
    clearTimeout(tipTimer);
    void refreshAvailability();
    tipTimer = setTimeout(() => {
      if (!drag && !selecting) showTip();
    }, 300);
  });
  ball.addEventListener('pointerleave', hideTip);
  ball.addEventListener('focus', () => !selecting && showTip());
  ball.addEventListener('blur', hideTip);
  hintExit.addEventListener('click', (event) => {
    event.preventDefault();
    exitSelection();
  });
  hintInsert.addEventListener('click', (event) => {
    event.preventDefault();
    void commit([...picked]);
  });

  // ---- global listeners (capture phase on document) ------------------------
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  };
  listen(document, 'pointermove', onPointerMove, { capture: true, passive: true });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu', 'auxclick']) {
    listen(document, type, swallow, { capture: true });
  }
  listen(document, 'click', onClick, { capture: true });
  listen(document, 'keydown', onKeyDown, { capture: true });
  listen(document, 'scroll', onScrollOrResize, { capture: true, passive: true });
  listen(window, 'resize', onScrollOrResize);

  const observer = new MutationObserver(() => updateVisibility());
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-state', 'open', 'data-vx-source'],
  });
  disposers.push(() => observer.disconnect());
  const availabilityTimer = setInterval(() => {
    if (ball.style.display !== 'none') void refreshAvailability();
  }, 2000);
  disposers.push(() => clearInterval(availabilityTimer));

  void loadConfig().then(() => refreshAvailability());

  return {
    enterSelection,
    exitSelection,
    dispose() {
      exitSelection();
      for (const d of disposers.splice(0)) d();
      clearTimeout(toastTimer);
      clearTimeout(tipTimer);
      if (rafId) cancelAnimationFrame(rafId);
      root.remove();
      style.remove();
    },
  };
}

export default {
  apiVersion: '2.0',
  id: PLUGIN_ID,
  activate(ctx) {
    if (typeof document === 'undefined') return undefined;
    // Main window only: settings / auxiliary windows get no ball, picker or shortcut.
    if (!isMainWindow(currentWindowInfo())) return undefined;
    const instance = createDebugger(ctx);
    const disposeCommand = ctx.ui?.registerCommand?.({
      id: 'select-element',
      title: 'TauriUI调试器：选择界面元素',
      category: 'Developer',
      icon: 'mouse-pointer-click',
      handler: () => instance.enterSelection(),
    });
    return () => {
      if (typeof disposeCommand === 'function') disposeCommand();
      instance.dispose();
    };
  },
};
