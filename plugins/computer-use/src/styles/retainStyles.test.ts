import path from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

import { retainStyle } from './retainStyles';

const require = createRequire(import.meta.url);

beforeAll(() => {
  if (typeof document !== 'undefined') return;
  const jsdomPath = require.resolve('jsdom', {
    paths: [path.resolve(process.cwd(), '../VibeX/frontend/node_modules')],
  });
  const { JSDOM } = require(jsdomPath);
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://127.0.0.1/',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLStyleElement: dom.window.HTMLStyleElement,
    MutationObserver: dom.window.MutationObserver,
  });
});

describe('retainStyle', () => {
  it('puts the stylesheet back after the host removes it', async () => {
    const release = retainStyle('vibex-plugin-computer-use', '.settings-page{color:red}');
    const first = document.getElementById('vibex-plugin-computer-use');
    expect(first?.textContent).toContain('color:red');
    first?.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.getElementById('vibex-plugin-computer-use')?.textContent).toContain(
      'color:red'
    );
    release();
    expect(document.getElementById('vibex-plugin-computer-use')).toBeNull();
  });
});
