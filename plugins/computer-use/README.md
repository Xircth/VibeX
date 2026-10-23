---
summary: 桌面窗口与应用感知及自动化控制插件，提供无障碍树快照、截图、校验、后台/前台键鼠输入、窗口级授权与全局紧急停止。
---
# 电脑控制 (Computer Use Plugin for VibeX)

桌面窗口与应用感知及自动化控制插件，为 VibeX Agent 提供完整的窗口级授权、无障碍树读取、截图、谓词验证、后台/前台输入投递、应用启动与剪贴板协同能力。

## 功能概览

- **窗口级与应用级共享授权**：支持单个窗口、整个应用或全屏的 `仅查看 (Read)` 与 `允许控制 (Control)` 两级授权，并提供带实时缩略图的窗口选择器。
- **18 个 MCP 工具**：
  - 感知与校验：`computer_list_apps`、`computer_list_windows`、`computer_snapshot`、`computer_screenshot`、`computer_verify`
  - 动作与输入：`computer_click`、`computer_drag`、`computer_scroll`、`computer_type`、`computer_press_key`、`computer_hold_key`、`computer_set_value`、`computer_restore`、`computer_invoke_menu`
  - 窗口与剪贴板：`computer_launch_app`、`computer_set_window_frame`、`computer_clipboard_read`、`computer_clipboard_write`
- **后台与前台输入投递**：默认通过无障碍动作、SendMessage 和虚拟指针在后台投递操作，无需抢占当前焦点窗口。
- **全局停止快捷键与紧急停止**：支持自定义全局停止快捷键（默认 `Ctrl+Alt+Shift+.` / `Cmd+Opt+Shift+.`），按下即刻撤销授权并中断正在执行的驱动动作。
- **永不共享名单 (Never-Share Blocklist)**：内置终端、浏览器、密码管理器、通讯工具等敏感分类预设，支持自定义添加应用名称、Bundle ID 或可执行文件名。
