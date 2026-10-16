import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type Node, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

function selectorOf(rule: Rule): string {
  return rule.selector.replace(/\s+/g, ' ');
}

function ruleInLayer(rule: Rule): boolean {
  let node: Node | undefined = rule.parent;
  while (node && node.type !== 'root') {
    if (node.type === 'atrule' && 'name' in node && node.name === 'layer') {
      return true;
    }
    node = node.parent;
  }
  return false;
}

function isAstryxInnerField(selector: string): boolean {
  return (
    selector.includes('.astryx-text-input') &&
    selector.includes('input') &&
    !selector.includes('.settings-page')
  );
}

function isProductTextFieldReset(selector: string): boolean {
  return (
    selector.includes('.legacy-design') &&
    selector.includes("input:not([type='checkbox'])") &&
    selector.includes('textarea') &&
    !selector.includes('.settings-page')
  );
}

describe('text control caret clearance', () => {
  it('lets Astryx TextInput own its frame instead of restyling the wrapper', () => {
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (!selector.includes('.astryx-text-input')) return;
      if (selector.includes('input') || selector.includes('textarea')) return;
      rule.walkDecls((declaration) => {
        expect(declaration.prop).not.toBe('padding');
        expect(declaration.prop).not.toBe('overflow');
      });
    });
  });

  it('strips the platform text-field appearance so Astryx chrome shows through', () => {
    const inner: Record<string, string> = {};
    const important = new Set<string>();
    let unlayeredAppearance = false;
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (!isAstryxInnerField(selector)) return;
      if (selector.includes('.dark') || selector.includes(':hover')) return;
      rule.walkDecls((declaration) => {
        inner[declaration.prop] = declaration.value;
        if (declaration.important) important.add(declaration.prop);
        if (
          !ruleInLayer(rule) &&
          (declaration.prop === 'appearance' ||
            declaration.prop === '-webkit-appearance') &&
          declaration.value === 'none'
        ) {
          unlayeredAppearance = true;
        }
      });
    });

    expect(inner.appearance).toBe('none');
    expect(inner['-webkit-appearance']).toBe('none');
    expect(inner['background-color']).toBe('transparent');
    expect(inner['background-image']).toBe('none');
    expect(inner['color-scheme']).toBe('only light');
    expect(important.has('appearance')).toBe(true);
    expect(important.has('-webkit-appearance')).toBe(true);
    expect(important.has('background-color')).toBe(true);
    expect(unlayeredAppearance).toBe(true);
  });

  it('strips native text-field appearance for every product text control', () => {
    const reset: Record<string, string> = {};
    let unlayeredAppearance = false;
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (!isProductTextFieldReset(selector)) return;
      if (selector.includes('.dark')) return;
      rule.walkDecls((declaration) => {
        reset[declaration.prop] = declaration.value;
        if (
          !ruleInLayer(rule) &&
          (declaration.prop === 'appearance' ||
            declaration.prop === '-webkit-appearance') &&
          declaration.value === 'none'
        ) {
          unlayeredAppearance = true;
        }
      });
    });

    expect(reset.appearance).toBe('none');
    expect(reset['-webkit-appearance']).toBe('none');
    expect(reset['color-scheme']).toBe('only light');
    expect(unlayeredAppearance).toBe(true);
  });

  it('gives standalone text controls an opaque fill so Win11 chrome cannot show through', () => {
    const fills: string[] = [];
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (!isProductTextFieldReset(selector)) return;
      if (!selector.includes('.astryx-text-input *')) return;
      rule.walkDecls((declaration) => {
        if (declaration.prop === 'background-color') {
          fills.push(declaration.value);
        }
      });
    });

    expect(fills.at(-1)).toBe('var(--surface-raised-control)');
  });

  it('hides platform password-reveal and search decorations on product inputs', () => {
    const reveal: Record<string, string> = {};
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (
        selector.includes('::-ms-reveal') ||
        selector.includes('::-webkit-search-decoration')
      ) {
        rule.walkDecls((declaration) => {
          reveal[`${selector} ${declaration.prop}`] = declaration.value;
        });
      }
    });

    expect(
      Object.entries(reveal).some(
        ([key, value]) => key.includes('::-ms-reveal') && value === 'none'
      )
    ).toBe(true);
    expect(
      Object.entries(reveal).some(
        ([key, value]) =>
          key.includes('::-webkit-search-decoration') && value === 'none'
      )
    ).toBe(true);
  });

  it('gives the light design scope a definite color-scheme so WebView2 does not paint Win11 fields', () => {
    const schemes: string[] = [];
    let htmlScheme: string | undefined;
    let htmlInLayer = true;
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (selector === '.legacy-design') {
        rule.walkDecls((declaration) => {
          if (declaration.prop === 'color-scheme') {
            schemes.push(declaration.value);
          }
        });
      }
      if (selector === 'html') {
        rule.walkDecls((declaration) => {
          if (declaration.prop === 'color-scheme') {
            htmlScheme = declaration.value;
            htmlInLayer = ruleInLayer(rule);
          }
        });
      }
    });

    expect(schemes.length).toBeGreaterThan(0);
    expect(schemes.at(-1)).toBe('light');
    expect(htmlScheme).toBe('only light');
    expect(htmlInLayer).toBe(false);
  });

  it('flips Astryx inner fields to the dark color-scheme with the app theme', () => {
    const darkSchemes: string[] = [];
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (!isAstryxInnerField(selector) || !selector.includes('.dark')) return;
      rule.walkDecls((declaration) => {
        if (declaration.prop === 'color-scheme') {
          darkSchemes.push(declaration.value);
        }
      });
    });

    expect(darkSchemes.at(-1)).toBe('only dark');
  });

  it('gives settings text fields a shared inset and compact type', () => {
    const shared: Record<string, string> = {};
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (
        !selector.includes('.settings-page') ||
        !selector.includes('input:not') ||
        selector.includes(
          '.legacy-design .settings-page :is(.astryx-text-input'
        )
      ) {
        return;
      }
      const declarations: Record<string, string> = {};
      rule.walkDecls((declaration) => {
        declarations[declaration.prop] = declaration.value;
      });
      if (declarations['padding-inline'] && declarations['font-size']) {
        Object.assign(shared, declarations);
      }
    });

    expect(shared['padding-inline']).toBe('10px');
    expect(shared['font-size']).toBe('0.75rem');
  });

  it('does not globally indent every native text control', () => {
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (
        !selector.includes(':where(.legacy-design) input') ||
        selector.includes('select')
      ) {
        return;
      }

      rule.walkDecls((declaration) => {
        expect(declaration.prop).not.toBe('text-indent');
        expect(declaration.prop).not.toBe('padding-inline');
      });
    });
  });

  it('guarantees Astryx input frame has an unselected border and focus-within accent ring', () => {
    const frameDecls: Record<string, string> = {};
    const focusDecls: Record<string, string> = {};

    const frameSelector =
      ".legacy-design :is( .astryx-text-input, .astryx-textarea, .astryx-selector[data-variant='input'] )";
    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (selector === frameSelector) {
        rule.walkDecls((d) => {
          frameDecls[d.prop] = d.value;
        });
      }
      if (selector === `${frameSelector}:focus-within`) {
        rule.walkDecls((d) => {
          focusDecls[d.prop] = d.value;
        });
      }
    });

    expect(frameDecls['border-width']).toBe('1px');
    expect(frameDecls['border-style']).toBe('solid');
    expect(frameDecls['border-color']).toContain('--color-border-emphasized');
    expect(focusDecls['border-color']).toContain('--color-accent');
    expect(focusDecls['box-shadow']).toContain('--color-accent-muted');
  });

  it('gives settings search and settings page inputs an opaque recessed gray fill on Windows WebView2', () => {
    const lightTokens: Record<string, string> = {};
    const darkTokens: Record<string, string> = {};
    const settingsInputFills: string[] = [];

    parse(stylesheet).walkRules((rule) => {
      const selector = selectorOf(rule);
      if (selector === '.legacy-design') {
        rule.walkDecls((d) => {
          lightTokens[d.prop] = d.value;
        });
      }
      if (selector.includes('.legacy-design.dark')) {
        rule.walkDecls((d) => {
          darkTokens[d.prop] = d.value;
        });
      }
      if (
        !ruleInLayer(rule) &&
        selector.includes('.legacy-design .settings-search-input') &&
        selector.includes('.legacy-design .settings-page')
      ) {
        rule.walkDecls((d) => {
          if (d.prop === 'background-color' && d.important) {
            settingsInputFills.push(d.value);
          }
        });
      }
    });

    expect(lightTokens['--surface-control-solid']).toBe('hsl(220 14% 94%)');
    expect(lightTokens['--surface-control-solid-hover']).toBe(
      'hsl(220 14% 92%)'
    );
    expect(lightTokens['--surface-raised']).toBe(
      'var(--surface-raised-control)'
    );
    expect(darkTokens['--surface-control-solid']).toBe('hsl(216 18% 22%)');
    expect(darkTokens['--surface-control-solid-hover']).toBe(
      'hsl(216 18% 25%)'
    );
    expect(darkTokens['--surface-raised']).toBe(
      'var(--surface-raised-control)'
    );
    expect(settingsInputFills).toContain('var(--surface-control-solid)');
  });
});
