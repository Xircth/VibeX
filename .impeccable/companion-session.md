# Companion session stream — design rules

Extracted from VibeX desktop conversation (`conv-messages.css`, `TurnToolCalls`, `SessionSettingsSummary`) and the 2026-08-20 session screenshots. Companion session pages follow these rules, not the CodeG rail.

## Surface

- Conversation content is an **opaque content layer**. No timeline gutter, no spine, no avatar rail.
- User turns hug the **right** edge. Assistant turns are flush **left**.
- Fold old history with one chip: `已折叠 N 条消息`. Expanding is the only extra chrome. Defaults come from Settings → 消息流控制: thinking hidden, failed tools hidden, tool groups collapsed, history folded.

## User bubble

- Max width ~82%.
- Fill: quiet wash (`textPrimary` ~6–8% on Paper / 10% on Ink). **No accent tint, no border.**
- Radius 14dp. Padding 10×14. Body 14/20.
- Markdown inside the bubble inherits bubble color.

## Assistant

- No agent avatar in the stream.
- Body 14/21. Headings 16–20 semibold. Tables and fenced code are opaque grouped surfaces (10–14dp radius, hairline).
- Inline code is a pill (codeSurface, 4dp radius), not a full block.

## Tool runs

- Consecutive tools between prose **group**. A new assistant paragraph **breaks** the group. Never dump a whole turn into one card.
- Collapsed label uses desktop copy, joined by `、`: `已读 N 个文件` / `已改 N 个文件` / `运行 N 个命令` / `完成 N 次搜索` / `获取 N 个网页` / `N 次其他工具调用`.
- Wrench + label + chevron. Flat, no nested cards inside the header.
- Expanded rows: status glyph (green check / red x / spinner) · action (`查看文件` / `编辑` / `终端` / `搜索` / `查看目录`) · file-type badge · filename. One row, 13sp.
- File body: line-numbered preview, header `查看`, copy. Collapse after ~20 lines.

## Composer

- One floating rounded rectangle (16dp) at the bottom, 12dp inset, 8dp shadow. No outer chrome ring.
- Inside the field: summary · enhance · usage · send/stop. `/ @ # &` tokens use desktop `[type:key](value)` markup and sit in the same wrapping line as the draft. One half-peek orb under the title on the left edge opens a tabbed panel (消息列表 default, 任务列表). Session and folder actions use long-press menus, not swipe.
- Send is a black circle with a white arrow. Empty + in-flight: red square stop. Text + in-flight: send queues.
- Queued inputs stack as cards above the field. Press to expand; dismiss cancels on Host.
- Summary and the menu both open a draggable custom sheet (handle, not Android ModalBottomSheet). Summary: 智能体选项 (workspace, branch, model, effort). Menu: session facts as cards; path truncates and long-press copies.

## Notices

- Session Error/Warning/Notice: **cards in the stream**, badge + title + body.
- Host timeout / pairing / connect: **global Banner** under the status bar, never in the composer stack.

## Honesty (ADR-0058)

Missing session config, usage, git stats, or agent icon stays missing. Never invent “默认” or a letter avatar when the catalog has a mark.


## Surfaces (Companion)

- **Sheet**: floating rounded rectangle over a dim overlay. 16dp left/right, 64dp from the bottom, 36dp on all four corners. Fill `#E6E7E9` (dark `#2A3038`). Inner groups `#F3F4F5`. Content max 480dp. Title centered.
- **Long-press menu**: no dim overlay. A floating card at the press point, clamped inside the screen.
- **Card / white component** `#F3F4F5` (dark `#343B45`): form groups, session rows, folder rows, agent rail. Small four-side shadow. No gray `codeSurface` wash for these blocks.
- **Radius** 14px globally. Drawer corners are the only 24px exception. Pills may stay fully round.
- **Search field** compact (~36dp), card fill, 14px radius.
- Long-press folder: 查看项目信息 / 创建新会话. Long-press session: 置顶 / 归档 / 删除.
