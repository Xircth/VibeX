import { describe, expect, it } from 'vitest';
import { rewriteAstryxRichtextCoreSource } from './astryxRichtextCoreAlias';

describe('rewriteAstryxRichtextCoreSource', () => {
  const richtextImporter =
    'C:/repo/node_modules/.pnpm/@astryxdesign+richtext@0.7.1/node_modules/@astryxdesign/richtext/dist/MarkdownExtensionsPlugin.js';

  it('rewrites richtext core imports so they do not resolve to 0.3.0', () => {
    expect(
      rewriteAstryxRichtextCoreSource(
        '@astryxdesign/core/Markdown/plugin-renderer',
        richtextImporter
      )
    ).toBe('@astryxdesign/core-rte/Markdown/plugin-renderer');
    expect(
      rewriteAstryxRichtextCoreSource('@astryxdesign/core', richtextImporter)
    ).toBe('@astryxdesign/core-rte');
  });

  it('leaves app and already-aliased imports unchanged', () => {
    expect(
      rewriteAstryxRichtextCoreSource(
        '@astryxdesign/core/Markdown/plugin-renderer',
        'C:/repo/frontend/src/components/previews/MarkdownRichTextEditor.tsx'
      )
    ).toBeNull();
    expect(
      rewriteAstryxRichtextCoreSource(
        '@astryxdesign/core-rte/Markdown/plugin-renderer',
        richtextImporter
      )
    ).toBeNull();
  });
});
