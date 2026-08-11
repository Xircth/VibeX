import '@testing-library/jest-dom/vitest';
// Initialize the i18n runtime so components using useTranslation render real
// strings instead of raw keys. Tests use a deterministic Chinese locale even
// though production now derives its initial locale from the host system.
import i18n from '@/i18n';
import './LiquidGlassMock';

const localStorageStore = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return localStorageStore.size;
  },
  clear() {
    localStorageStore.clear();
  },
  getItem(key: string) {
    return localStorageStore.get(key) ?? null;
  },
  key(index: number) {
    return Array.from(localStorageStore.keys())[index] ?? null;
  },
  removeItem(key: string) {
    localStorageStore.delete(key);
  },
  setItem(key: string, value: string) {
    localStorageStore.set(key, String(value));
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorageMock,
});

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: localStorageMock,
});

beforeEach(async () => {
  localStorageMock.clear();
  if (i18n.language !== 'zh-CN') await i18n.changeLanguage('zh-CN');
});

// Mock Tauri API - all invoke calls return undefined by default
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class MockChannel<T> {
    onmessage: (message: T) => void = () => undefined;
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
  once: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn(),
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  exists: vi.fn(),
}));

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// jsdom 28 ships its own Popover API whose UA styles keep `[popover]` at
// `display: none` and whose visibility state does not respond to the `open`
// attribute alone. Override unconditionally so popover content is visible to
// testing-library queries in jsdom.
Object.defineProperty(HTMLElement.prototype, 'showPopover', {
  configurable: true,
  writable: true,
  value: function showPopover() {
    this.setAttribute('open', '');
    this.style.setProperty('display', 'block', 'important');
  },
});
Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
  configurable: true,
  writable: true,
  value: function hidePopover() {
    this.removeAttribute('open');
    this.style.setProperty('display', '', 'important');
  },
});
