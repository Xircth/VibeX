# 小布输入法（`com.oplus.keyboard`）魔改版与开源增强生态全景调研报告

> **调研日期**：2026-11-08
> **核心结论**：
> 1. **小布输入法本身（包名 `com.oplus.keyboard`）是 OPPO / OnePlus 在 ColorOS 16/17 中推出的闭源系统级应用**，不存在将小布输入法本体完整重写的“独立开源 APK 源码”。
> 2. 但在 GitHub 开源社区中，已经有 **5 个专门针对小布输入法（及旧版 ColorOS 百度定制版输入法）进行深度魔改、破除系统限制、移植百度输入法核心交互、开启全局液态玻璃模糊与按键下滑快捷键的开源 LSPosed/Xposed 项目**，其中代表作 `Sharl210/xiaobu-ime-assistant` 的 GitHub Releases 中还**随包附带了配套的原版宿主 APK（`XiaobuInputMethod-1.8.33.17-mkt-host.apk`）**。
> 3. 若你指的是**“把小布语音/小布助手替换为自定义大模型或自定义 TTS 音色”**，GitHub 上也有 `Zafiro` 与 `BVoice` 两个专门的开源魔改模块。

---

## 一、 核心盘点：GitHub 上针对「小布输入法 (`com.oplus.keyboard`)」的 5 大魔改开源项目

### 1. [`Sharl210/xiaobu-ime-assistant`](https://github.com/Sharl210/xiaobu-ime-assistant) —— **小布输入法助手（最纯粹的专项深度魔改项目）**
* **开源协议**：AGPL-3.0
* **项目定位**：专为 `com.oplus.keyboard` 打造的独立 LSPosed 魔改模块，作者口号是**“复活吧，我的百度输入法！”**——专门解决 ColorOS 换用自研小布输入法后操作习惯反人类、限制多的问题。
* **核心魔改功能**：
  1. **文本编辑面板重排（百度输入法布局移植）**：将原生难用的文本编辑面板重排为两列三行（`全选/剪切`、`删除`、`复制`、`回车`、`粘贴`、`剪贴板`），左上格随选区自动在“全选/剪切”间切换。
  2. **剪贴板与常用语破限**：
     - 解除剪贴板条目数量上限（计数上限改为 `∞`），新增**剪贴板内搜索过滤**与**单条内容直接编辑写回数据库**功能；
     - 解除常用语正文的 **500 字上限** 及 **条目数量上限**。
  3. **上滑符号集与英文候选改造**：
     - 将中文/英文 26 键的上滑输入符号集改为百度输入法习惯（如中文逗号上滑直接输出中文感叹号 `！`）；
     - 英文键盘新增书册图标一键切换“英文候选”开关状态；
     - 抑制输入引号、括号时强制自动补全闭合符号的行为。
  4. **拼音候选区光标编辑**：点击组合拼音文本可直接移动闪烁光标并围绕该位置插入/退格（还原百度输入法体验）。
  5. **SSH / 终端主键盘回车修复**：修复小布输入法在 Termux / SSH 终端中按回车无法正常发送 `KEYCODE_ENTER` 的痛点。
* **亮点资源**：其 GitHub Releases 要求**同时上传模块 APK（`OplusImePanel-x.x.x-release.apk`）与已验证匹配的真实小布输入法宿主 APK（如 `XiaobuInputMethod-1.8.33.17-mkt-host.apk`）**，并且仓库内的 `reverse_evidence/` 目录公开了完整的逆向分析文档。

---

### 2. [`Mubai-meng/FKColorOS`](https://github.com/Mubai-meng/FKColorOS) —— **内置「小布输入法 · 液态玻璃模糊 + 26键/九宫格下滑快捷键」**
* **技术栈**：Kotlin + Jetpack Compose + Modern `libxposed API 102`（面向 ColorOS 17 / OnePlus 15）
* **针对小布输入法（`com.oplus.keyboard`）的两大核心魔改**：
  1. **强制开启全局液态玻璃模糊（解除白名单限制）**：
     - 原版小布输入法在 `input.manager.k#a` 中硬编码了仅在 8 个系统白名单应用（设置、软件商店、小布记忆等）才开启高斯模糊，在微信、QQ 等第三方 App 中全部降级为纯色背景。
     - 该模块通过 Hook 模糊总闸 `base.util.h#b()`、`c()` 及 `ViewRootManager#setBlurRadius`，**在所有第三方 App 中强制开启小布输入法的液态玻璃动态模糊**，并支持在 `50..500` 范围内自由调节模糊半径。
  2. **按键下滑执行 26 种编辑动作（完整移植自闭源模块 `app.xiaobuswipe`）**：
     - 支持 26 键（默认绑定 `Z=全选`、`X=剪切`、`C=复制`、`V=粘贴`）与九宫格（2~9 键）独立配置下滑快捷动作；
     - 支持 26 种动作：全选、剪切、复制、粘贴、撤销、重做、段首/段尾、文首/文尾、直接呼出原生剪贴板面板（`body.H`）、快捷短语面板、粘贴并发送、切换输入法、插入自定义文本等；
     - 支持在键面绘制自定义动作短标签（自动 / 隐藏 / 自定义 1~4 字）。
* **硬核文档**：仓库下的 [`docs/小布输入法功能移植-方案与实证.md`](https://github.com/Mubai-meng/FKColorOS/blob/main/docs/%E5%B0%8F%E5%B8%83%E8%BE%93%E5%85%A5%E6%B3%95%E5%8A%9F%E8%83%BD%E7%A7%BB%E6%A4%8D-%E6%96%B9%E6%A1%88%E4%B8%8E%E5%AE%9E%E8%AF%81.md) 提供了小布输入法 `1.8.35.17` 极其详尽的 JADX 逆向类结构表。

---

### 3. [`MiToverG422/ONextBox`](https://github.com/MiToverG422/ONextBox) —— **小布输入法莫奈取色（Monet）与按键视觉深度定制**
* **开源协议**：GPL-3.0（ColorOS 16/17 扩展工具箱）
* **针对小布输入法（`com.oplus.keyboard`）的魔改能力**：
  1. **打破 8 个系统应用材质白名单**（见源码 `app/src/main/java/com/mi/onextbox/lsp/KeyboardMaterialRules.kt`）：放开 `com.heytap.quicksearchbox`、`com.android.settings` 等仅 8 个系统应用才能触发键盘材质的限制，实现全应用材质统一。
  2. **全局莫奈动态取色（Monet）**：强制开启小布输入法的莫奈壁纸取色，覆盖按键、工具栏、工具箱、长按气泡弹窗、语音输入面板与悬浮键盘。
  3. **键盘外观微调与 Emoji 补全**：支持自定义背景模糊强度、材质遮罩、键盘与按键圆角、字号、描边、阴影，并恢复被阉割的旗帜类 Emoji 显示。

---

### 4. [`JerryTse-OSS/XiaobuIME_Bypass`](https://github.com/JerryTse-OSS/XiaobuIME_Bypass) —— **旧版系统/跨机型安装小布输入法的激活验证绕过模块**
* **解决痛点**：小布输入法 APK 提取安装到 ColorOS 16 及更低版本（OSDK < 40）或非首发机型上时，会触发内部的 `key_activate` 鉴权拦截导致无法启用。
* **实现原理**：极其轻量（核心代码仅 50 行 `BypassModule.java`），通过 Xposed 拦截 `android.app.SharedPreferencesImpl#getBoolean`（针对 `"key_activate"` 恒返回 `true`）以及 `com.oplus.keyboard.utils.storage.a` 下的布尔校验方法，实现跨系统版本强行激活小布输入法。
* **附带彩蛋**：其 README 公开了 OPPO 官方小布输入法最新安装包直链查询 API：
  `https://kbd-api-cn.heytapmobi.com/base/app/version/lastest?appName=com.oplus.keyboard&versionCode=000001`

---

### 5. [`luckyzyx/LuckyTool`](https://github.com/luckyzyx/LuckyTool) & [`Sharl210/fuckinginput.coloros.baidu`](https://github.com/Sharl210/fuckinginput.coloros.baidu)
* **LuckyTool**（GPL-3.0）：老牌 ColorOS 扩展模块，其 `OplusKeyboardPage.kt` 提供了最早的 `force_enable_oplus_keyboard_blur`（强制开启小布输入法模糊及 50~500 半径调节）开源实现。
* **fuckinginput.coloros.baidu**：同为 `Sharl210` 维护，针对 ColorOS 旧版内置的「百度输入法 OPPO 定制版（`com.baidu.input_oppo`）」，利用 DexKit 2.2.0 解除复制 7000 字截断、剪贴板 14000 字过滤、快捷短语 100 条与 300 字上限（该部分同样被移植进了 `FKColorOS` 的 `docs/输入法限制解锁-移植与优化.md`）。

---

## 二、 延伸排查：如果你指的是「小布语音/助手」魔改或「纯开源本地 AI 输入法」

1. **小布语音/小布助手的开源魔改模块（LSPosed）**：
   - **[`Xposed-Modules-Repo/com.niki914.zafiro`](https://github.com/Xposed-Modules-Repo/com.niki914.zafiro)（Zafiro）**：劫持 ColorOS 小布助手唤醒，将其底层替换为自定义大模型 Agent（支持 MCP、Skills、读取屏幕与跨应用自动输入）。
   - **[`Xposed-Modules-Repo/dev.breenottshook`](https://github.com/Xposed-Modules-Repo/dev.breenottshook)（BVoice）**：Hook 小布语音 TTS，接入自建的 `GPT-SoVITS` 服务替换小布音色。
2. **完全开源的 Android 本地 AI / 离线语音输入法平替**：
   - **[`1zumiii/suzu-ime`](https://github.com/1zumiii/suzu-ime)（Suzu 输入法）**：基于 Rime 改造的本地 AI 拼音输入法，内置端侧小模型推理核心，根据上文自动重排候选词与简拼补全，完全离线无隐私上传。
   - **[`Cyletix/CyIME`](https://github.com/Cyletix/CyIME)**：基于 Rime 的 GPLv3 开源中文输入法，内置本地离线语音识别、手写与自训练九键模型。

---

## 三、 选型与使用建议

| 你的具体诉求 | 推荐直接使用的开源项目 |
| :--- | :--- |
| **觉得小布输入法编辑面板、上滑符号、剪贴板限制太难用，想改成百度输入法的手感** | 首选 **[`Sharl210/xiaobu-ime-assistant`](https://github.com/Sharl210/xiaobu-ime-assistant)**（Releases 里自带配套的小布输入法原版 APK 与模块 APK） |
| **想要给小布输入法加上“26键下滑全选/复制/粘贴快捷键” + “微信等全应用液态玻璃模糊”** | 首选 **[`Mubai-meng/FKColorOS`](https://github.com/Mubai-meng/FKColorOS)**（并可参考其 `docs/小布输入法功能移植-方案与实证.md` 逆向文档） |
| **想要小布输入法支持全局莫奈壁纸取色（Monet）、调按键圆角/透明度/补全旗帜 Emoji** | 首选 **[`MiToverG422/ONextBox`](https://github.com/MiToverG422/ONextBox)** |
| **在非 ColorOS 17 或旧机型上提取安装小布输入法 APK 后提示未激活/闪退** | 使用 **[`JerryTse-OSS/XiaobuIME_Bypass`](https://github.com/JerryTse-OSS/XiaobuIME_Bypass)** 绕过 `key_activate` 校验 |
