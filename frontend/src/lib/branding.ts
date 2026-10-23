export const APP_NAME = 'VibeX';

export const DEFAULT_SITE_URL = 'https://vibex.xforever.xin';

export function getSiteUrl(path = ''): string {
  const raw =
    import.meta.env.VIBEX_SITE_URL ||
    import.meta.env.VITE_VIBEX_SITE_URL ||
    DEFAULT_SITE_URL;
  const base = String(raw).trim().replace(/\/+$/, '') || DEFAULT_SITE_URL;
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
