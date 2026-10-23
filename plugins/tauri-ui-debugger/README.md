---
summary: 开发模式下点选界面元素，把源码位置、组件链和关键样式作为 token 插入会话输入框。
---
# TauriUI调试器

开发模式下（页面存在 `data-vx-source` 标注时）在窗口左下角显示悬浮球。点击或按快捷键进入选择模式，
点选界面元素后，把源码位置 / 组件链 / 关键样式作为 element token 插入最近聚焦的会话输入框。

- `Esc` 退出，`Alt` 选父级，`Shift`+点击多选（`Enter` 插入），按住 `Ctrl`（macOS `⌘`）点击可穿透到页面。
- 配置在「插件详情 → 配置」。
- 源码标注由 `frontend/vite.config.ts` 中仅 dev 生效的 babel 插件注入。
