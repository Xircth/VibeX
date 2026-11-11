---
summary: Ayu Light, Mirage, and Dark color themes for the VibeX window, editor, and terminal.
---
# Ayu Theme

Three color themes from the [ayu](https://github.com/ayu-theme) palette:

| Theme | Scheme | Page | Text | Accent |
| --- | --- | --- | --- | --- |
| Ayu Light | Light | `#fcfcfc` | `#5c6166` | `#cf6610` |
| Ayu Mirage | Dark | `#242936` | `#cccac2` | `#ffcc66` |
| Ayu Dark | Dark | `#10141c` | `#bfbdb6` | `#e6b450` |

Each theme repaints the window frame, pages, panels, menus, borders, status
colors, the code editor, the terminal, and syntax highlighting.

## Use

1. Install and enable the plugin.
2. Open **Settings → Appearance**.
3. Under the theme cards, pick **Ayu Light** for light mode and **Ayu Mirage**
   or **Ayu Dark** for dark mode. Light and dark are chosen separately; the
   window follows the light/dark mode set above them.

The themes use Ayu's own accent. An accent color set in Appearance overrides
it; choose **Follow theme** next to the accent to return to Ayu's.

To adjust a variant, pick **Duplicate and edit** beside it. The copy is saved
as your own theme, so plugin updates never overwrite it.

## Notes

- Colors come from the `ayu` 9.1.0 palette. Ayu Light uses Ayu's deeper
  orange (`#cf6610`) instead of the stock tint (`#f29718`) so focus rings and
  selected rows reach 3:1 against the page. Set `#f29718` as the accent to get
  the stock look.
- Pure color data: no code runs, no network access, and nothing is stored
  beyond your theme choice. While the plugin is disabled or uninstalled, a
  scheme set to an Ayu theme shows the VibeX theme; enabling the plugin again
  brings Ayu back.

## License

The ayu palette is MIT-licensed, © Konstantin Pschera
([ayu-theme/ayu-colors](https://github.com/ayu-theme/ayu-colors)).
