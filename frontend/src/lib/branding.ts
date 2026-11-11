export const APP_NAME = 'VibeX';

export const DEFAULT_SITE_URL = 'https://vibex.xforever.xin';
export const DEFAULT_DEV_SITE_URL = 'http://localhost:3100';

function resolveDefaultSiteUrl(): string {
  if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
    return DEFAULT_DEV_SITE_URL;
  }
  return DEFAULT_SITE_URL;
}

export function getSiteUrl(path = ''): string {
  const fallback = resolveDefaultSiteUrl();
  const raw =
    import.meta.env.VIBEX_SITE_URL ||
    import.meta.env.VITE_VIBEX_SITE_URL ||
    fallback;
  const base = String(raw).trim().replace(/\/+$/, '') || fallback;
  if (!path) return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function getSiteHost(): string {
  try {
    return new URL(getSiteUrl()).hostname.toLowerCase();
  } catch {
    return new URL(DEFAULT_SITE_URL).hostname.toLowerCase();
  }
}

export function getMarketplaceHost(): string {
  const raw =
    import.meta.env.VIBEX_MARKETPLACE_URL ||
    import.meta.env.VITE_VIBEX_MARKETPLACE_URL ||
    getSiteUrl();
  try {
    return new URL(String(raw).trim()).hostname.toLowerCase();
  } catch {
    return getSiteHost();
  }
}
