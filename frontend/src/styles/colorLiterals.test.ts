import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { type Declaration, parse } from 'postcss';
import { describe, expect, it } from 'vitest';

/*
 * Colors flow from the token blocks in `styles/legacy/index.css` so that a
 * color theme can repaint the whole app. Component code references tokens;
 * a literal color outside the token blocks is invisible to every theme.
 */

const SRC = resolve(process.cwd(), 'src');
const TOKEN_FILE = 'styles/legacy/index.css';

const TOKEN_BLOCK_SELECTORS = new Set([
  ':root',
  'html',
  'html.dark',
  '.dark',
  '.legacy-design',
  '.legacy-design.dark',
  '.dark .legacy-design',
]);

/* Mask images only read alpha, so their color stops never reach the screen. */
const ALPHA_ONLY_PROPERTIES = new Set([
  'mask',
  'mask-image',
  '-webkit-mask',
  '-webkit-mask-image',
]);

/*
 * Colors that must not change with the theme: third-party brand marks, the
 * terminal ANSI palette, annotation pens, avatar artwork, the accent picker's
 * own hue math, the built-in theme definitions themselves, and the mock
 * palette of the unified-shell design prototype. `true` exempts the whole
 * file; a list exempts only those literals.
 */
const LITERAL_COLOR_OWNERS: Record<string, true | readonly string[]> = {
  'components/agents/AgentTypeIcon.tsx': true,
  'components/connectors/connectorCatalog.ts': true,
  'components/connectors/ConnectorMarketplace.tsx': [
    'bg-[#181717]',
    'bg-[#171717]',
    'text-[#3ecf8e]',
    'border-orange-500',
    'bg-orange-500',
    'text-orange-500',
    'bg-[#0ea5e9]',
    'text-white',
  ],
  'components/onboarding/hero/AgentMark.tsx': true,
  'components/onboarding/hero/EquationIcons.tsx': true,
  'components/previews/imagePreviewAnnotations.ts': true,
  'features/collaboration/GroupAvatar.tsx': true,
  'features/collaboration/MemberBotAvatar.tsx': true,
  'features/collaboration/space/CollaborationSpaceRuntime.tsx': ['#38bdf8'],
  'lib/theme/builtinThemes.ts': true,
  'lib/uiAccent.ts': true,
  'pages/UnifiedShellPrototype.tsx': true,
  'pages/plugins/OfficialPluginIcon.tsx': true,
  'pages/settings/AccentColorField.tsx': true,
  'utils/icons.ts': true,
  'utils/terminalTheme.ts': true,
};

const COLOR_LITERALS = [
  /(?<![\w&-])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\w-])/gi,
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?!var\(|from\b)[\d.-][^)]*\)/gi,
  /var\(--[\w-]+,\s*-?[\d.]+\s+[\d.]+%\s+[\d.]+%\s*\)/g,
];

const NAMED_COLOR =
  /(?<![\w-])(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|cyan|magenta)(?![\w-])/gi;

const COLOR_PROPERTY =
  /^(?:--.*|color|background(?:-color|-image)?|border(?:-[a-z]+)*|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|scrollbar-color|stop-color|flood-color|lighting-color)$/;

const UTILITY = String.raw`(?:bg|text|border|ring|ring-offset|outline|fill|stroke|from|via|to|divide|placeholder|caret|accent|decoration|shadow)`;
const PALETTE = String.raw`(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)`;

const PALETTE_CLASS = new RegExp(
  String.raw`(?<![\w-])(?:[a-z-]+:)*(${UTILITY}-(?:${PALETTE}-\d{2,3}|white|black|\[(?:#[\da-f]+|(?:rgba?|hsla?)\((?!var\()[^\]]*)\]))(?![\w-])`,
  'gi'
);

function walk(dir: string, accept: (file: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, accept);
    return accept(path) ? [path] : [];
  });
}

function sourcePath(file: string): string {
  return relative(SRC, file).replaceAll('\\', '/');
}

function isTestFile(file: string): boolean {
  return /\.(?:test|spec)\.[jt]sx?$/.test(file) || file.includes('__tests__');
}

function literalsIn(value: string, property: string): string[] {
  const literals = COLOR_LITERALS.flatMap((pattern) =>
    Array.from(value.matchAll(pattern), (match) => match[0])
  );
  if (COLOR_PROPERTY.test(property)) {
    const withoutUrls = value.replace(/url\([^)]*\)/g, '');
    for (const match of withoutUrls.matchAll(NAMED_COLOR)) {
      literals.push(match[0]);
    }
  }
  return literals;
}

function isTokenBlock(declaration: Declaration, file: string): boolean {
  if (file !== TOKEN_FILE || !declaration.prop.startsWith('--')) return false;
  const rule = declaration.parent;
  if (rule?.type !== 'rule' || !('selectors' in rule)) return false;
  return (rule.selectors as string[]).every((selector) =>
    TOKEN_BLOCK_SELECTORS.has(selector.trim())
  );
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

function cssViolations(): string[] {
  const violations: string[] = [];
  for (const file of walk(SRC, (path) => path.endsWith('.css'))) {
    const path = sourcePath(file);
    parse(readFileSync(file, 'utf8')).walkDecls((declaration) => {
      if (ALPHA_ONLY_PROPERTIES.has(declaration.prop)) return;
      if (isTokenBlock(declaration, path)) return;
      for (const literal of literalsIn(declaration.value, declaration.prop)) {
        violations.push(
          `${path}:${declaration.source?.start?.line} ${declaration.prop}: ${literal}`
        );
      }
    });
  }
  return violations;
}

function scriptViolations(): string[] {
  const violations: string[] = [];
  const files = walk(
    SRC,
    (path) => /\.[jt]sx?$/.test(path) && !path.endsWith('.d.ts')
  );
  for (const file of files) {
    const path = sourcePath(file);
    const owned = LITERAL_COLOR_OWNERS[path];
    if (isTestFile(path) || owned === true) continue;
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const literals = [
        ...Array.from(line.matchAll(PALETTE_CLASS), (match) => match[1]),
        ...literalsIn(line.replace(PALETTE_CLASS, ''), 'script'),
      ];
      for (const literal of literals) {
        if (owned?.includes(literal)) continue;
        violations.push(`${path}:${index + 1} ${literal}`);
      }
    });
  }
  return violations;
}

function tokenGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  parse(readFileSync(join(SRC, TOKEN_FILE), 'utf8')).walkDecls(
    (declaration) => {
      if (!isTokenBlock(declaration, TOKEN_FILE)) return;
      const edges = graph.get(declaration.prop) ?? new Set<string>();
      for (const match of declaration.value.matchAll(/var\((--[\w-]+)/g)) {
        edges.add(match[1]);
      }
      graph.set(declaration.prop, edges);
    }
  );
  return graph;
}

function findCycle(graph: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (token: string): string[] | null => {
    if (state.get(token) === 'done') return null;
    if (state.get(token) === 'visiting') {
      return [...stack.slice(stack.indexOf(token)), token];
    }
    state.set(token, 'visiting');
    stack.push(token);
    for (const next of graph.get(token) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(token, 'done');
    return null;
  };
  for (const token of graph.keys()) {
    const cycle = visit(token);
    if (cycle) return cycle;
  }
  return null;
}

describe('color literals', () => {
  it('keeps literal colors in stylesheets inside the token blocks', () => {
    expect(cssViolations()).toEqual([]);
  });

  it('keeps literal colors and palette classes out of components', () => {
    expect(scriptViolations()).toEqual([]);
  });

  it('names only files that still exist as literal color owners', () => {
    const missing = Object.keys(LITERAL_COLOR_OWNERS).filter(
      (path) => !existsSync(join(SRC, path))
    );
    expect(missing).toEqual([]);
  });

  it('recognizes the literal forms it guards against', () => {
    expect(literalsIn('1px solid #1d2530', 'border')).toEqual(['#1d2530']);
    expect(literalsIn('rgba(0, 0, 0, 0.4)', 'box-shadow')).toEqual([
      'rgba(0, 0, 0, 0.4)',
    ]);
    expect(literalsIn('hsl(var(--border) / 0.5)', 'color')).toEqual([]);
    expect(literalsIn('var(--x, 220 10% 50%)', 'color')).toEqual([
      'var(--x, 220 10% 50%)',
    ]);
    expect(literalsIn('white', 'background')).toEqual(['white']);
    expect(literalsIn('white', 'white-space')).toEqual([]);
    expect(
      Array.from(
        'hover:bg-red-500/10 bg-[#fff] text-[hsl(var(--x))] text-white'.matchAll(
          PALETTE_CLASS
        ),
        (match) => match[1]
      )
    ).toEqual(['bg-red-500', 'bg-[#fff]', 'text-white']);
  });

  it('keeps the token blocks free of reference cycles', () => {
    expect(findCycle(tokenGraph())).toBeNull();
  });
});
