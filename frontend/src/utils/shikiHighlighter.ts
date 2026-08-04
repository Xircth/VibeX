import { useEffect, useState, type CSSProperties } from 'react';
import type {
  BundledLanguage,
  BundledTheme,
  Highlighter,
  SpecialLanguage,
  ThemedTokenWithVariants,
  TokenStyles,
} from 'shiki';
import { resolvePreviewLanguageFromPath } from './fileLanguageRegistry';

const LIGHT_THEME: BundledTheme = 'github-light';
const DARK_THEME: BundledTheme = 'github-dark-default';
const PLAIN_LANGUAGE = 'text';
const TOKEN_CACHE_LIMIT = 160;

const INITIAL_LANGUAGES = [
  'bash',
  'css',
  'diff',
  'html',
  'javascript',
  'json',
  'markdown',
  'python',
  'rust',
  'tsx',
  'typescript',
  'yaml',
] satisfies BundledLanguage[];

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  h: 'c',
  hpp: 'cpp',
  js: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  ps: 'powershell',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  shell: 'bash',
  sh: 'bash',
  ts: 'typescript',
  yml: 'yaml',
};

type ShikiRuntime = typeof import('shiki');

export type ShikiCodeLanguage = string;
export type ShikiTokenLines = ThemedTokenWithVariants[][];
export type ShikiTokenCssProperties = CSSProperties & {
  '--shiki-token-light'?: string;
  '--shiki-token-dark'?: string;
};

let highlighterPromise: Promise<Highlighter> | null = null;
let shikiRuntimePromise: Promise<ShikiRuntime> | null = null;
const loadedLanguages = new Set<string>([...INITIAL_LANGUAGES, PLAIN_LANGUAGE]);
const tokenCache = new Map<string, ShikiTokenLines>();

export function languageFromPath(path?: string | null) {
  return resolvePreviewLanguageFromPath(path);
}

export function normalizeShikiLanguage(
  language?: string | null
): ShikiCodeLanguage {
  const rawLanguage = language?.trim().toLowerCase();
  if (!rawLanguage) return PLAIN_LANGUAGE;

  const aliasedLanguage = LANGUAGE_ALIASES[rawLanguage] ?? rawLanguage;
  if (/^[a-z0-9][a-z0-9_+-]*$/i.test(aliasedLanguage)) {
    return aliasedLanguage;
  }

  return PLAIN_LANGUAGE;
}

export function createPlainTokenLines(value: string): ShikiTokenLines {
  const lines = value.split('\n');
  return (lines.length ? lines : ['']).map((line) =>
    line
      ? [
          {
            content: line,
            offset: 0,
            variants: {
              light: {},
              dark: {},
            },
          },
        ]
      : []
  );
}

export async function highlightCodeToTokens(
  value: string,
  language: ShikiCodeLanguage
) {
  const cacheKey = getTokenCacheKey(value, language);
  const cachedTokens = tokenCache.get(cacheKey);
  if (cachedTokens) return cachedTokens;

  const { highlighter, resolvedLanguage } = await ensureLanguage(language);
  const tokens = highlighter.codeToTokensWithThemes(value, {
    lang: resolvedLanguage as BundledLanguage | SpecialLanguage,
    themes: {
      light: LIGHT_THEME,
      dark: DARK_THEME,
    },
    tokenizeMaxLineLength: 20_000,
    tokenizeTimeLimit: 300,
  });

  writeTokenCache(cacheKey, tokens);
  return tokens;
}

export function useShikiTokens(value: string, language: ShikiCodeLanguage) {
  const cacheKey = getTokenCacheKey(value, language);
  const [tokens, setTokens] = useState<ShikiTokenLines>(
    () => tokenCache.get(cacheKey) ?? createPlainTokenLines(value)
  );

  useEffect(() => {
    let isCurrent = true;
    const cachedTokens = tokenCache.get(cacheKey);

    if (cachedTokens) {
      setTokens(cachedTokens);
      return () => {
        isCurrent = false;
      };
    }

    if (!value) {
      setTokens(createPlainTokenLines(value));
      return () => {
        isCurrent = false;
      };
    }

    highlightCodeToTokens(value, language)
      .then((nextTokens) => {
        if (isCurrent) setTokens(nextTokens);
      })
      .catch(() => {
        if (isCurrent) setTokens(createPlainTokenLines(value));
      });

    return () => {
      isCurrent = false;
    };
  }, [cacheKey, language, value]);

  return tokens;
}

export function getShikiTokenStyle(
  token: ThemedTokenWithVariants
): ShikiTokenCssProperties {
  const lightVariant = token.variants.light;
  const darkVariant = token.variants.dark;

  return {
    // Token color is theme-isolated via the CSS variables below, but font
    // styling is plain inline CSS that applies to both color schemes at once.
    // Only emit font styles shared by both theme variants so a style present in
    // just one theme never bleeds into the other.
    ...getSharedVariantFontStyle(lightVariant, darkVariant),
    '--shiki-token-light': lightVariant?.color,
    '--shiki-token-dark': darkVariant?.color,
  };
}

function getShikiRuntime() {
  if (!shikiRuntimePromise) {
    shikiRuntimePromise = import('shiki').catch((error) => {
      shikiRuntimePromise = null;
      throw error;
    });
  }

  return shikiRuntimePromise;
}

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = getShikiRuntime()
      .then(({ createHighlighter }) =>
        createHighlighter({
          themes: [LIGHT_THEME, DARK_THEME],
          langs: [...INITIAL_LANGUAGES, PLAIN_LANGUAGE],
        })
      )
      .catch((error) => {
        highlighterPromise = null;
        throw error;
      });
  }

  return highlighterPromise;
}

async function ensureLanguage(language: ShikiCodeLanguage) {
  const resolvedLanguage = await resolveBundledLanguage(language);
  const highlighter = await getHighlighter();
  if (!loadedLanguages.has(resolvedLanguage)) {
    try {
      await highlighter.loadLanguage(resolvedLanguage as BundledLanguage);
      loadedLanguages.add(resolvedLanguage);
    } catch {
      return { highlighter, resolvedLanguage: PLAIN_LANGUAGE };
    }
  }

  return { highlighter, resolvedLanguage };
}

async function resolveBundledLanguage(language: ShikiCodeLanguage) {
  if (language === PLAIN_LANGUAGE) return PLAIN_LANGUAGE;

  try {
    const { bundledLanguages } = await getShikiRuntime();
    return Object.prototype.hasOwnProperty.call(bundledLanguages, language)
      ? language
      : PLAIN_LANGUAGE;
  } catch {
    return PLAIN_LANGUAGE;
  }
}

function getTokenCacheKey(value: string, language: ShikiCodeLanguage) {
  return `${language}\u0000${value}`;
}

function writeTokenCache(key: string, tokens: ShikiTokenLines) {
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey) tokenCache.delete(oldestKey);
  }

  tokenCache.set(key, tokens);
}

function getSharedVariantFontStyle(
  light?: TokenStyles,
  dark?: TokenStyles
): CSSProperties {
  // Shiki encodes fontStyle as a bitmask (1=italic, 2=bold, 4=underline) and
  // uses -1 for "not set"; clamp negatives to 0 so an unset variant contributes
  // no styles, then intersect so only shared bits survive.
  const lightFontStyle = Math.max(light?.fontStyle ?? 0, 0);
  const darkFontStyle = Math.max(dark?.fontStyle ?? 0, 0);
  const sharedFontStyle = lightFontStyle & darkFontStyle;
  if (!sharedFontStyle) return {};

  const style: CSSProperties = {};
  if (sharedFontStyle & 1) style.fontStyle = 'italic';
  if (sharedFontStyle & 2) style.fontWeight = 600;
  if (sharedFontStyle & 4) style.textDecoration = 'underline';

  return style;
}
