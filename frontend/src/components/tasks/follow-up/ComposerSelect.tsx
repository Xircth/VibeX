import type { PointerEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared styling for the composer's selector dropdowns (session mode picker
 * and the ACP config-option pickers), so they stay visually identical.
 */

/** Bold, theme-aware (black / white) dropdown title, no divider below it. */
export const COMPOSER_SELECT_LABEL_CLASS =
  'px-2 py-1 text-sm font-bold text-foreground';

/**
 * Height-capped option list with an extra-thin scrollbar (class defined in
 * styles/legacy/index.css).
 */
export const COMPOSER_SELECT_LIST_CLASS = 'composer-select-list';

/**
 * Option row. Hover feedback comes from plain CSS (not Radix highlight): item
 * pointer-move handling is disabled via `blockItemPointerMoveFocus`, so the
 * `focus:` style only ever reflects keyboard navigation.
 */
export const COMPOSER_SELECT_ITEM_CLASS =
  'flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--surface-control-hover)]';

/**
 * Radix focuses a menu item when the pointer moves over it; with a partially
 * visible item at the edge of the scrollable list that focus nudges the list
 * (auto-scroll on plain mouse movement). preventDefault() makes Radix's
 * composed pointer-move handler skip its hover-focus entirely — selection
 * (click) and keyboard navigation are unaffected.
 */
export function blockItemPointerMoveFocus(event: PointerEvent<HTMLElement>) {
  event.preventDefault();
}

/**
 * Option name inside a translucent, theme-aware pill. The selected option's
 * name renders with the flowing blue gradient. The option's description is a
 * native hover tooltip (`title`) instead of an always-visible sub-line, to
 * keep the menu narrow. The gradient lives on an inner span:
 * `background-clip: text` would otherwise also clip the pill's own translucent
 * background to the glyphs.
 */
export function ComposerOptionName({
  active,
  title,
  children,
}: {
  active: boolean;
  title?: string | null;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-block max-w-full rounded-md bg-foreground/[0.06] px-1.5 py-0.5"
      title={title ?? undefined}
    >
      <span
        className={cn(
          'block truncate text-sm leading-5',
          active ? 'composer-option-flow font-semibold' : 'text-foreground'
        )}
      >
        {children}
      </span>
    </span>
  );
}
