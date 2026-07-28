# Tauri App 元素检查器

VibeX 可以对当前工作区中的 Tauri v2 源码项目安装一个仅在 debug
构建中启用的元素检查器。检查器基于开源
[`tauri-plugin-redline`](https://github.com/twiced-technology-gmbh/redline-plugin-tauri)
（MIT）实现，并增加了 VibeX 的项目内回传桥。

## 首次启用

1. 在 VibeX 中打开包含 `src-tauri/` 的源码项目。
2. 点击右侧竖向工具栏中的“扫描元素”按钮。
3. VibeX 会修改当前工作区副本：
   - 在 `src-tauri/Cargo.toml` 中加入 Redline 和 VibeX 伴生插件；
   - 在 Tauri Builder 中以 `cfg!(debug_assertions)` 注册插件；
   - 为一个 JSON capability 加入 `redline:default` 和
     `vibex-inspector:default`；
   - 生成 `.vibex/tauri-plugin-vibex-inspector/` 回传桥。
4. 重新启动该项目的 Tauri 开发版 App。

如果项目使用自定义 Builder、非标准 `src-tauri/` 布局或 TOML
capability，安装器会停止并显示错误，不会继续猜测性修改。

## 日常使用

1. 保持目标 Tauri App 和对应的 VibeX 会话同时打开。
2. 再次点击 VibeX 右侧工具栏中的“扫描元素”按钮。
3. 切换到目标 App。Redline 覆盖层会自动出现。
4. 点选元素，并输入希望 Agent 执行的修改说明。也可以使用框选、箭头、
   自由绘制等 Redline 标注。
5. macOS 按 `Cmd+Option+Shift+A`，Windows/Linux 按
   `Ctrl+Alt+Shift+A` 完成标注。
6. VibeX 会自动接收 selector、元素 HTML、计算样式、坐标和修改说明，
   并把元素 chip 插入当前 Agent 输入框。补充一句整体要求后即可发送。

Redline 仍会保留它原有的 JSON 下载行为，便于故障时手工恢复；VibeX
不需要用户选择或上传这个 JSON。

## 范围和安全性

- 只支持 VibeX 当前工作区中的源码项目，不会尝试附加任意已安装 App。
- 插件注册放在 `debug_assertions` 分支，release 运行时不会启用覆盖层。
- 回传只写入项目自身的 `.vibex/inspector/inbox/`，VibeX 后端根据
  workspace ID 解析路径；前端不能指定任意文件路径。
- 当前 Redline 数据提供 DOM selector、HTML 和计算样式。React/Vue
  源码文件位置取决于目标项目自身是否额外提供 source metadata。
