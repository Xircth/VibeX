import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLESHEET = resolve(process.cwd(), 'src/styles/dockview-ayu.css');

function rules(): Rule[] {
  return parse(readFileSync(STYLESHEET, 'utf8')).nodes.filter(
    (node): node is Rule => node.type === 'rule'
  );
}

function selector(rule: Rule): string {
  return rule.selector.replace(/\s+/g, ' ').trim();
}

function declaration(rule: Rule, prop: string): string | undefined {
  let value: string | undefined;
  rule.walkDecls(prop, (decl) => {
    value = decl.value;
  });
  return value;
}

describe('workspace dockview sash', () => {
  it('draws a 1px line and a centered capsule for every horizontal sash state', () => {
    const line = rules().find((rule) =>
      selector(rule).endsWith(
        '.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash'
      )
    );
    const capsule = rules().find((rule) =>
      selector(rule).endsWith(
        '.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash::after'
      )
    );

    expect(line).toBeTruthy();
    expect(selector(line!)).not.toContain('dv-enabled');
    expect(declaration(line!, 'width')).toBe('1px');
    expect(declaration(line!, 'background-color')).toBe(
      'var(--workspace-divider-color, var(--dv-sash-color))'
    );
    expect(declaration(capsule!, 'width')).toBe('4px');
    expect(declaration(capsule!, 'height')).toBe('21px');
    expect(selector(capsule!)).not.toContain('dv-enabled');
  });

  it('keeps the horizontal hover and active states on the hairline and capsule', () => {
    const line = rules().find(
      (rule) =>
        selector(rule).includes('.dv-sash:hover') &&
        selector(rule).includes('.dv-horizontal') &&
        selector(rule).includes('.dv-sash:active') &&
        !selector(rule).includes('::after')
    );
    const capsule = rules().find(
      (rule) =>
        selector(rule).includes('.dv-sash:hover::after') &&
        selector(rule).includes('.dv-horizontal') &&
        selector(rule).includes('.dv-sash:active::after')
    );

    expect(declaration(line!, 'background-color')).toBe(
      'var(--workspace-divider-hover, var(--dv-active-sash-color))'
    );
    expect(declaration(capsule!, 'transform')).toBe(
      'translate(-50%, -50%) scaleX(1.35)'
    );
  });

  it('draws the same hairline and capsule for vertical sashes', () => {
    const line = rules().find((rule) =>
      selector(rule).endsWith(
        '.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash'
      )
    );
    const capsule = rules().find((rule) =>
      selector(rule).endsWith(
        '.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash::after'
      )
    );

    expect(selector(line!)).not.toContain('dv-enabled');
    expect(declaration(line!, 'height')).toBe('1px');
    expect(declaration(capsule!, 'width')).toBe('21px');
    expect(declaration(capsule!, 'height')).toBe('4px');
  });

  it('hides the library separator so it cannot stack into a thick bar', () => {
    const hidden = rules().find(
      (rule) =>
        selector(rule).includes('.dv-horizontal') &&
        selector(rule).includes('.dv-vertical') &&
        selector(rule).includes('::before') &&
        selector(rule).includes('.dv-view:not(:first-child)')
    );
    const theme = rules().find((rule) =>
      selector(rule).startsWith('.dockview-theme-light.dockview-theme-ayu')
    );

    expect(declaration(hidden!, 'display')).toBe('none');
    expect(declaration(theme!, '--dv-separator-border')).toBe('transparent');
    expect(declaration(theme!, '--dv-active-sash-color')).toBe(
      'var(--workspace-divider-hover)'
    );
  });
});
