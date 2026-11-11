import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEETS = [
  'src/styles/legacy/index.css',
  'src/styles/dockview-ayu.css',
  'src/components/ui/toast.css',
];

function isFirefoxScrollbarFallback(rule: Rule): boolean {
  let node:
    | { type?: string; name?: string; params?: string; parent?: unknown }
    | undefined = rule.parent ?? undefined;
  while (node) {
    if (node.type === 'atrule') {
      const atrule = node as AtRule;
      if (
        atrule.name === 'supports' &&
        /not\s+selector\(\s*::-webkit-scrollbar\s*\)/.test(atrule.params)
      ) {
        return true;
      }
    }
    const next = node.parent;
    node =
      next && typeof next === 'object'
        ? (next as NonNullable<typeof node>)
        : undefined;
  }
  return false;
}

function standardScrollbarPaintHits(css: string, file: string) {
  const hits: string[] = [];
  parse(css).walkRules((rule) => {
    if (isFirefoxScrollbarFallback(rule)) return;
    rule.walkDecls((declaration) => {
      const paintsTrack =
        declaration.prop === 'scrollbar-color' ||
        (declaration.prop === 'scrollbar-width' &&
          declaration.value !== 'none');
      if (!paintsTrack) return;
      hits.push(
        `${file} ${rule.selector.replace(/\s+/g, ' ')} { ${declaration.prop}: ${declaration.value} }`
      );
    });
  });
  return hits;
}

describe('thumb-only scrollbars', () => {
  it('keeps scrollbar-width and scrollbar-color off the WebKit path', () => {
    const hits = STYLESHEETS.flatMap((relative) =>
      standardScrollbarPaintHits(
        readFileSync(resolve(process.cwd(), relative), 'utf8'),
        relative
      )
    );

    expect(hits).toEqual([]);
  });

  it('keeps native scrollbars from consuming layout width', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/styles/legacy/index.css'),
      'utf8'
    );

    expect(css).toMatch(
      /\.legacy-design,\s*\.legacy-design \* \{\s*scrollbar-width:\s*none;/
    );
    expect(css).not.toMatch(/scrollbar-width:\s*thin/);
  });
});
