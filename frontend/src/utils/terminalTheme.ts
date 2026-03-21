import type { ITheme } from '@xterm/xterm';

function toHex(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, '0');
}

function cssColorToHex(colorValue: string): string | null {
  const value = colorValue.trim();
  if (!value) return null;

  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const raw = hexMatch[1];
    if (raw.length === 3) {
      return `#${raw
        .split('')
        .map((char) => char + char)
        .join('')
        .toLowerCase()}`;
    }
    return `#${raw.toLowerCase()}`;
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch) return null;

  const channels = rgbMatch[1].match(/[\d.]+/g);
  if (!channels || channels.length < 3) return null;

  const red = Number.parseFloat(channels[0]);
  const green = Number.parseFloat(channels[1]);
  const blue = Number.parseFloat(channels[2]);

  if (
    !Number.isFinite(red) ||
    !Number.isFinite(green) ||
    !Number.isFinite(blue)
  ) {
    return null;
  }

  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function resolveThemeColor(
  cssExpression: string,
  fallbackHex: string,
  mode: 'color' | 'backgroundColor' = 'color'
): string {
  if (typeof document === 'undefined') {
    return fallbackHex;
  }

  const scopeEl =
    (document.querySelector('.legacy-design') as HTMLElement | null) ??
    document.documentElement;
  const probe = document.createElement('div');

  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.width = '0';
  probe.style.height = '0';
  probe.style.opacity = '0';

  if (mode === 'backgroundColor') {
    probe.style.backgroundColor = cssExpression;
  } else {
    probe.style.color = cssExpression;
  }

  scopeEl.appendChild(probe);

  const computedStyle = getComputedStyle(probe);
  const resolvedValue =
    mode === 'backgroundColor'
      ? computedStyle.backgroundColor
      : computedStyle.color;

  scopeEl.removeChild(probe);

  return cssColorToHex(resolvedValue) ?? fallbackHex;
}

/**
 * Build an xterm.js theme from CSS variables defined in index.css.
 * Uses --console-background and --console-foreground as the main colors,
 * and derives ANSI colors from a combination of theme-appropriate defaults.
 */
export function getTerminalTheme(): ITheme {
  // Detect if we're in dark mode by checking the class on html element
  const isDark = document.documentElement.classList.contains('dark');

  const bgHex = resolveThemeColor(
    'hsl(var(--console-background))',
    isDark ? '#10151f' : '#f3f4f6',
    'backgroundColor'
  );
  const fgHex = resolveThemeColor(
    'hsl(var(--console-foreground))',
    isDark ? '#c8d2dc' : '#39424e'
  );
  const greenHex = resolveThemeColor(
    'hsl(var(--console-success))',
    isDark ? '#9adf76' : '#5f9e15'
  );
  const redHex = resolveThemeColor(
    'hsl(var(--console-error))',
    isDark ? '#f87171' : '#e33636'
  );

  // Define ANSI palette based on light/dark mode
  // These are carefully chosen to be readable on the respective backgrounds
  if (isDark) {
    return {
      background: bgHex,
      foreground: fgHex,
      cursor: fgHex,
      cursorAccent: bgHex,
      selectionBackground: '#3d4966',
      selectionForeground: fgHex,
      black: '#1a1a1a',
      red: redHex,
      green: greenHex,
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#c0caf5',
      brightBlack: '#545c7e',
      brightRed: redHex,
      brightGreen: greenHex,
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: fgHex,
    };
  } else {
    // Light mode colors
    return {
      background: bgHex,
      foreground: fgHex,
      cursor: fgHex,
      cursorAccent: bgHex,
      selectionBackground: '#accef7',
      selectionForeground: '#1a1a1a',
      black: '#1a1a1a',
      red: redHex,
      green: greenHex,
      yellow: '#946800',
      blue: '#0550ae',
      magenta: '#a626a4',
      cyan: '#0e7490',
      white: '#57606a',
      brightBlack: '#4b5563',
      brightRed: redHex,
      brightGreen: greenHex,
      brightYellow: '#7c5800',
      brightBlue: '#0969da',
      brightMagenta: '#8250df',
      brightCyan: '#0891b2',
      brightWhite: fgHex,
    };
  }
}
