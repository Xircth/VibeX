export const BLANK_PAGE = 'about:blank';

export function normalizeBrowserUrl(value: string): string {
  const target = value.trim();
  if (!target) return BLANK_PAGE;
  if (
    /^(https?|file):\/\//i.test(target) ||
    /^(about|data|view-source):/i.test(target)
  ) {
    return target;
  }

  const localHost =
    /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/#?]|$)/i;
  return `${localHost.test(target) ? 'http' : 'https'}://${target}`;
}

export function browserUrlsEquivalent(left: string, right: string): boolean {
  const normalize = (value: string) =>
    normalizeBrowserUrl(value).replace(/\/+$/, '');
  return normalize(left) === normalize(right);
}
