import { describe, expect, it } from 'vitest';
import { createManualChunks } from '../../vite.manualChunks';

describe('createManualChunks', () => {
  it('gives each Shiki grammar its own chunk and keeps the preload helper with React', () => {
    expect(
      createManualChunks(
        'C:/repo/node_modules/@shikijs/langs/dist/typescript.mjs'
      )
    ).toBe('shiki-lang-typescript');
    expect(
      createManualChunks('C:/repo/node_modules/@shikijs/langs/dist/zig.mjs')
    ).toBe('shiki-lang-zig');
    expect(
      createManualChunks(
        'C:/repo/node_modules/@shikijs/langs/dist/emacs-lisp.mjs'
      )
    ).not.toBe(
      createManualChunks('C:/repo/node_modules/@shikijs/langs/dist/zig.mjs')
    );
    expect(
      createManualChunks(
        'C:/repo/node_modules/@shikijs/themes/dist/github-dark-default.mjs'
      )
    ).toBeUndefined();
    expect(
      createManualChunks('C:/repo/node_modules/@shikijs/core/dist/index.mjs')
    ).toBe('vendor-shiki-core');
    expect(createManualChunks('\0vite/preload-helper.js')).toBe('vendor-react');
  });

  it('splits heavy optional libraries out of the startup vendor chunk', () => {
    expect(
      createManualChunks('C:/repo/node_modules/@xyflow/react/dist/esm/index.js')
    ).toBe('vendor-xyflow');
    expect(createManualChunks('C:/repo/node_modules/gsap/index.js')).toBe(
      'vendor-gsap'
    );
    expect(
      createManualChunks('C:/repo/node_modules/react-markdown/index.js')
    ).toBe('vendor-markdown');
    expect(
      createManualChunks('C:/repo/node_modules/dockview-react/dist/index.js')
    ).toBe('vendor-dockview');
  });

  it('keeps React, Radix, and lucide in the startup vendor-react chunk', () => {
    expect(createManualChunks('C:/repo/node_modules/react/index.js')).toBe(
      'vendor-react'
    );
    expect(
      createManualChunks('C:/repo/node_modules/react-dom/client.js')
    ).toBe('vendor-react');
    expect(
      createManualChunks('C:/repo/node_modules/@radix-ui/react-dialog/dist/index.js')
    ).toBe('vendor-react');
    expect(
      createManualChunks('C:/repo/node_modules/lucide-react/dist/esm/icons/eye.js')
    ).toBe('vendor-react');
  });

  it('puts d3 with the canvas chunk and leaves design-system modules unassigned', () => {
    expect(
      createManualChunks('C:/repo/node_modules/d3-selection/src/index.js')
    ).toBe('vendor-xyflow');
    expect(
      createManualChunks(
        'C:/repo/node_modules/@astryxdesign/core/TextInput/index.js'
      )
    ).toBeUndefined();
    expect(
      createManualChunks('C:/repo/node_modules/mermaid/dist/mermaid.js')
    ).toBeUndefined();
  });
});
