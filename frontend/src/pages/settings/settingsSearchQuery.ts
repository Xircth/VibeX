import type { SettingsSearchEntry } from './settingsSearchCatalog';

export type ResolvedSettingsSearchEntry = SettingsSearchEntry & {
  label: string;
  group: string;
};

export function matchSettingsSearch(
  entries: ResolvedSettingsSearchEntry[],
  query: string
): ResolvedSettingsSearchEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return entries.filter((entry) => {
    return (
      entry.label.toLowerCase().includes(needle) ||
      entry.group.toLowerCase().includes(needle)
    );
  });
}

export function findSettingsHighlightTarget(
  root: ParentNode,
  label: string
): HTMLElement | null {
  const needle = label.trim().toLowerCase();
  if (!needle) return null;
  const selectors =
    'h2, h3, h4, label, [data-settings-search-id], .settings-nav-button, legend';
  const exact: HTMLElement[] = [];
  const partial: HTMLElement[] = [];
  root.querySelectorAll(selectors).forEach((node) => {
    const text = node.textContent?.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) return;
    if (text === needle) exact.push(node as HTMLElement);
    else if (text.includes(needle) && text.length <= needle.length + 48) {
      partial.push(node as HTMLElement);
    }
  });
  return exact[0] ?? partial[0] ?? null;
}

export function applySettingsSearchHighlight(
  root: ParentNode,
  label: string
): HTMLElement | null {
  const target = findSettingsHighlightTarget(root, label);
  if (!target) return null;
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  target.classList.remove('settings-search-flash');
  void target.offsetWidth;
  target.classList.add('settings-search-flash');
  const clear = () => target.classList.remove('settings-search-flash');
  target.addEventListener('animationend', clear, { once: true });
  window.setTimeout(clear, 1600);
  return target;
}
