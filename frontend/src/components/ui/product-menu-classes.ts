/** Visual contract shared with `.product-context-menu` rows. */
export const PRODUCT_MENU_CONTENT_CLASS =
  'product-context-menu rounded-md border border-border bg-white p-1 font-sans text-[13px] leading-5 text-popover-foreground shadow-none dark:bg-popover';

export const PRODUCT_MENU_ITEM_CLASS =
  'relative flex cursor-pointer select-none items-center gap-2 rounded-sm text-left text-[13px] leading-5 outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0';

/**
 * Single-select option row. Hover is the only fill. Selection is a trailing
 * check, so a hovered row cannot fuse with the selected row's background.
 */
export const PRODUCT_OPTION_ITEM_CLASS =
  'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[13px] leading-5 text-popover-foreground outline-none transition-colors hover:bg-accent focus:bg-accent focus-visible:bg-accent data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0';

export const PRODUCT_MENU_SEPARATOR_CLASS = 'mx-1 my-1 h-px bg-border/60';
