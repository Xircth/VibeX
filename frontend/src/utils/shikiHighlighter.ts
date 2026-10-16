import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type {
  HighlighterCore,
  ThemedTokenWithVariants,
  TokenStyles,
} from 'shiki/core';
import type { BundledLanguage } from 'shiki/langs';
import { resolvePreviewLanguageFromPath } from './fileLanguageRegistry';

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark-default';
const PLAIN_LANGUAGE = 'text';
const TOKEN_CACHE_LIMIT = 64;

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

type ShikiLangs = typeof import('shiki/langs');

export type ShikiCodeLanguage = string;
export type ShikiTokenLines = ThemedTokenWithVariants[][];
export type ShikiTokenCssProperties = CSSProperties & {
  '--shiki-token-light'?: string;
  '--shiki-token-dark'?: string;
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
let shikiLangsPromise: Promise<ShikiLangs> | null = null;
const loadedLanguages = new Set<string>([PLAIN_LANGUAGE]);
const loadingLanguagePromises = new Map<string, Promise<void>>();
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

/** Complete lines are those followed by a newline. The last line stays remainder. */
export function splitCompleteLinePrefix(value: string): {
  prefix: string;
  remainder: string;
} {
  const newlineIndex = value.lastIndexOf('\n');
  if (newlineIndex === -1) {
    return { prefix: '', remainder: value };
  }
  return {
    prefix: value.slice(0, newlineIndex + 1),
    remainder: value.slice(newlineIndex + 1),
  };
}

export function reuseStableTokenLines(
  previousValue: string,
  previousTokens: ShikiTokenLines,
  nextValue: string
): { reused: ShikiTokenLines; remainder: string } | null {
  const { prefix } = splitCompleteLinePrefix(previousValue);
  if (!prefix || !nextValue.startsWith(prefix)) {
    return null;
  }

  const prefixLineCount = prefix.split('\n').length - 1;
  if (previousTokens.length < prefixLineCount) {
    return null;
  }

  return {
    reused: previousTokens.slice(0, prefixLineCount),
    remainder: nextValue.slice(prefix.length),
  };
}

export async function highlightCodeToTokens(
  value: string,
  language: ShikiCodeLanguage,
  options?: { cache?: boolean }
) {
  const cacheKey = getTokenCacheKey(value, language);
  const cachedTokens = tokenCache.get(cacheKey);
  if (cachedTokens) return cachedTokens;

  const { highlighter, resolvedLanguage } = await ensureLanguage(language);
  const tokens = highlighter.codeToTokensWithThemes(value, {
    lang: resolvedLanguage,
    themes: {
      light: LIGHT_THEME,
      dark: DARK_THEME,
    },
    tokenizeMaxLineLength: 20_000,
    tokenizeTimeLimit: 300,
  });

  if (options?.cache !== false) {
    writeTokenCache(cacheKey, tokens);
  }
  return tokens;
}

export function useShikiTokens(
  value: string,
  language: ShikiCodeLanguage,
  options?: { incremental?: boolean }
) {
  const cacheKey = getTokenCacheKey(value, language);
  const incremental = Boolean(options?.incremental);
  const previousRef = useRef<{
    value: string;
    language: ShikiCodeLanguage;
    tokens: ShikiTokenLines;
  } | null>(null);
  const [tokens, setTokens] = useState<ShikiTokenLines>(
    () => tokenCache.get(cacheKey) ?? createPlainTokenLines(value)
  );

  useEffect(() => {
    let isCurrent = true;
    const cachedTokens = tokenCache.get(cacheKey);

    if (cachedTokens) {
      previousRef.current = { value, language, tokens: cachedTokens };
      setTokens(cachedTokens);
      return () => {
        isCurrent = false;
      };
    }

    if (!value) {
      previousRef.current = {
        value,
        language,
        tokens: createPlainTokenLines(value),
      };
      setTokens(createPlainTokenLines(value));
      return () => {
        isCurrent = false;
      };
    }

    if (
      incremental &&
      previousRef.current &&
      previousRef.current.language === language
    ) {
      const reused = reuseStableTokenLines(
        previousRef.current.value,
        previousRef.current.tokens,
        value
      );
      if (reused) {
        const immediate = reused.remainder
          ? [...reused.reused, ...createPlainTokenLines(reused.remainder)]
          : reused.reused;
        previousRef.current = { value, language, tokens: immediate };
        setTokens(immediate);
        if (!reused.remainder) {
          return () => {
            isCurrent = false;
          };
        }
        highlightCodeToTokens(reused.remainder, language, { cache: false })
          .then((remainderTokens) => {
            if (!isCurrent) return;
            const nextTokens = [...reused.reused, ...remainderTokens];
            previousRef.current = { value, language, tokens: nextTokens };
            setTokens(nextTokens);
          })
          .catch(() => {
            if (isCurrent) setTokens(immediate);
          });
        return () => {
          isCurrent = false;
        };
      }
    }

    highlightCodeToTokens(value, language, {
      cache: !incremental,
    })
      .then((nextTokens) => {
        if (!isCurrent) return;
        previousRef.current = { value, language, tokens: nextTokens };
        setTokens(nextTokens);
      })
      .catch(() => {
        if (isCurrent) setTokens(createPlainTokenLines(value));
      });

    return () => {
      isCurrent = false;
    };
  }, [cacheKey, incremental, language, value]);

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

function getShikiLangs() {
  if (!shikiLangsPromise) {
    shikiLangsPromise = import('shiki/langs').catch((error) => {
      shikiLangsPromise = null;
      throw error;
    });
  }

  return shikiLangsPromise;
}

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
      .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
        createHighlighterCore({
          themes: [
            import('shiki/themes/github-light.mjs'),
            import('shiki/themes/github-dark-default.mjs'),
          ],
          langs: [],
          engine: createJavaScriptRegexEngine(),
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
    let pendingLoad = loadingLanguagePromises.get(resolvedLanguage);
    if (!pendingLoad) {
      pendingLoad = (async () => {
        const { bundledLanguages } = await getShikiLangs();
        const loader = bundledLanguages[resolvedLanguage as BundledLanguage];
        if (!loader) {
          throw new Error(`Missing Shiki language loader: ${resolvedLanguage}`);
        }
        await highlighter.loadLanguage(loader);
        loadedLanguages.add(resolvedLanguage);
      })().finally(() => {
        loadingLanguagePromises.delete(resolvedLanguage);
      });
      loadingLanguagePromises.set(resolvedLanguage, pendingLoad);
    }
    try {
      await pendingLoad;
    } catch {
      return { highlighter, resolvedLanguage: PLAIN_LANGUAGE };
    }
  }

  return { highlighter, resolvedLanguage };
}

async function resolveBundledLanguage(language: ShikiCodeLanguage) {
  if (language === PLAIN_LANGUAGE) return PLAIN_LANGUAGE;

  try {
    const { bundledLanguages } = await getShikiLangs();
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
