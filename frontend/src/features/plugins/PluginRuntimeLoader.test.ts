import { describe, expect, it } from 'vitest';

import {
  evaluateSingleFileEsmModule,
  rewriteSharedBareImports,
} from './PluginRuntimeLoader';

describe('PluginRuntimeLoader ESM fallback', () => {
  it('rewrites shared bare imports without touching nested export lists in strings', () => {
    const code = `
import { definePluginApp } from '@vibex/plugin-sdk/app';
const note = \`
export { hidden as default }
\`;
export default definePluginApp;
`;
    const rewritten = rewriteSharedBareImports(code);
    expect(rewritten).toContain(
      'globalThis.__VIBEX_HOST_MODULES__["@vibex/plugin-sdk/app"]'
    );
    expect(rewritten).toContain('export { hidden as default }');
  });

  it('evaluates top-level export { a, b } into the module object', () => {
    const mod = evaluateSingleFileEsmModule(`
const a = 1;
const b = 2;
export { a, b };
`);
    expect(mod).toEqual({ a: 1, b: 2 });
  });

  it('evaluates top-level export { x as default }', () => {
    const mod = evaluateSingleFileEsmModule(`
function activate() { return 'ok'; }
export { activate as default };
`);
    expect(typeof mod.default).toBe('function');
    expect((mod.default as () => string)()).toBe('ok');
  });

  it('evaluates multiline export lists and shared re-exports', () => {
    const mod = evaluateSingleFileEsmModule(`
const local = 'kept';
export {
  local as alias,
  local as default
};
export { defineVibeXPlugin } from '@vibex/plugin-sdk';
`);
    expect(mod.alias).toBe('kept');
    expect(mod.default).toBe('kept');
    expect(typeof mod.defineVibeXPlugin).toBe('function');
  });

  it('does not rewrite export lists that only appear inside template strings', () => {
    const mod = evaluateSingleFileEsmModule(`
const a = 7;
const source = \`
export { a, b }
\`;
export default source;
`);
    expect(mod.a).toBeUndefined();
    expect(String(mod.default)).toContain('export { a, b }');
  });
});
