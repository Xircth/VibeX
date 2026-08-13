# VibeX 图片预览与编辑开源方案评估

日期：2026-08-11

## 结论

**不建议现在直接接入一个“全家桶”图片编辑器。** 当前没有成熟的开源单库同时满足
VibeX 的 React 19、Tauri 本地优先、底部原生工具栏、OCR、区域马赛克、裁剪、批注、
撤销/重做和导出要求。

建议采用两阶段方案：

1. **先实现自研图片预览标签页骨架**：Workspace 内在现有 Dockview 中打开唯一图片标签页，
   先提供可靠的查看、缩放、适应窗口、旋转和“另存为”；Kanban 继续使用轻量弹窗预览。
   工具栏只展示已经可用的动作，不放不可用占位按钮。
2. **编辑能力采用组合库**：以 `react-konva` + `konva` 实现裁剪、批注、区域马赛克、
   撤销/重做与导出；以懒加载、完全本地化的 `tesseract.js` 实现 OCR。不要让 OCR 或图片
   数据访问公网 CDN。

这条路径比接入成品编辑器工作量更大，但与 VibeX 的 React 状态、Dockview 生命周期、
自定义工具栏和本地文件安全边界更一致，且不会把产品锁在一个难以换肤的第三方 UI 中。

## VibeX 约束

- VibeX 当前使用 React `^19.2.8`，见
  [`frontend/package.json`](../../frontend/package.json)。
- Workspace 标签页应复用 Dockview 作为布局与标签的唯一权威；不要在图片编辑器中再造一套
  标签或分屏模型，见 [ADR-0042](../adr/0042-conversations-are-first-class-dockview-panels.md)。
- 图片和 OCR 默认必须留在本机；写回源文件必须由用户显式确认，默认使用“另存为”。
- 预览与编辑应支持卸载/重挂载，释放 Canvas、对象 URL、Web Worker 和 GPU 缓存。

## 候选方案比较

| 方案 | OCR | 区域马赛克 | 裁剪 | 批注 | 撤销/重做 | 导出 | React 19 / 维护状态 | 判断 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| React-Konva + Konva | 需组合 | 需封装 | 有官方实现范式 | 需组装图形/画笔 | 用不可变状态实现 | 支持 | React 19.2 明确支持，近期发布 | **推荐编辑底座** |
| Fabric.js 7 | 需组合 | 有 Pixelate 底层能力，区域工具需封装 | 有 crop 属性/近期裁剪控件 | 图形、文字、画笔较完整 | 需自建历史 | JSON/SVG/图片 | 框架无关、活跃 | 备选底座 |
| Filerobot Image Editor | 无 | 未提供明确的区域马赛克工具 | 有 | 有 | 有 | 有 | React 19 版本仍为 beta | 不直接集成 |
| TOAST UI Image Editor | 无 | 有 Pixelate 滤镜，但区域遮挡仍需扩展 | 有 | 有 | 有 | 有 | React wrapper 只声明 React 17，发布停滞 | 淘汰 |
| Tesseract.js | **有** | 无 | 无 | 可返回文本/位置供叠加 | 不适用 | 文本/结构化结果 | 框架无关、活跃 | **推荐 OCR 引擎** |

### 1. React-Konva + Konva

`react-konva` 是 Konva 的 React binding。npm 当前 `19.2.5` 明确要求 React/React DOM
`^19.2.0`，正好覆盖 VibeX 的 React 版本；Konva `10.3.0` 与 wrapper 都是 MIT，且均在
近期持续发布（[`react-konva` npm](https://www.npmjs.com/package/react-konva?activeTab=versions)、
[`konva` npm](https://www.npmjs.com/package/konva?activeTab=versions)）。

能力覆盖：

- 官方提供 React 自由绘制示例，画笔数据保留为向量状态，也说明这种状态模型便于保存与
  撤销/重做（[Free Drawing](https://konvajs.org/docs/react/Free_Drawing.html)）。
- 官方撤销/重做方案是保存不可变状态历史，而不是序列化整个 Canvas
  （[Undo/Redo](https://konvajs.org/docs/react/Undo-Redo.html)）。这适合把编辑文档状态与
  Dockview panel 生命周期分离。
- 官方已有可拖拽裁剪框、Transformer 和按区域导出的 React 示例
  （[Canvas Crop Image](https://konvajs.org/docs/sandbox/Canvas_Crop_Image.html)）。
- Konva 内置 Pixelate filter；区域马赛克仍需 VibeX 把选区对应的图片片段复制为单独节点、
  缓存后应用滤镜，不能把“全图 Pixelate”误当作遮挡工具
  （[Pixelate](https://konvajs.org/docs/filters/Pixelate.html)、
  [Filters API](https://konvajs.org/api/Konva.Filters.html)）。
- Stage/节点可以导出指定区域、格式与质量
  （[Stage Data URL](https://konvajs.org/docs/data_and_serialization/Stage_Data_URL.html)）。

主要成本是 VibeX 需要自己实现工具状态机、选区、文字编辑层、键盘快捷键、历史压缩、原图
坐标与视口坐标换算，以及大图性能策略。Konva 官方也明确指出完整 Canvas editor 涉及对象
选择、变换、文字、分层、历史和导出，是显著工程工作
（[Canvas Editor](https://konvajs.org/docs/sandbox/Canvas_Editor.html)）。

体积方面，npm registry 的发布包 `react-konva` 约 76 KiB、`konva` 约 1.41 MiB
（均为 **unpacked size，不是最终 gzip 包体**；见
[`react-konva` registry](https://registry.npmjs.org/react-konva/latest) 与
[`konva` registry](https://registry.npmjs.org/konva/latest)）。官方还提供 minimal core import，
允许只注册使用到的 shape/filter，减少前端初始包体
（[`react-konva` npm 文档](https://www.npmjs.com/package/react-konva)）。图片编辑器应按标签页
懒加载，而不是进入 Workspace 时加载。

### 2. Fabric.js 7

Fabric.js 是 MIT、框架无关的 Canvas 对象层。当前 npm `7.4.0` 近期发布，提供选择、移动、
旋转、图形、文字、画笔、滤镜、JSON/SVG/图片导出
（[`fabric` npm](https://www.npmjs.com/package/fabric?activeTab=versions)、
[Fabric core concepts](https://fabricjs.com/docs/core-concepts/)）。近期 release 也仍在增加裁剪控件
（[Fabric releases](https://github.com/fabricjs/fabric.js/releases)）。

它的优势是编辑对象模型比 Konva 更接近图片编辑器，序列化和文字对象更成熟；但 React 中要
自行管理命令式 Canvas 的创建、事件解绑、异步 `dispose()` 和状态同步。Fabric 官方说明
`dispose()` 需要等待渲染稳定后销毁 Canvas；滤镜还可能创建 GPU texture，需要随图片/Canvas
释放（[Canvas API](https://fabricjs.com/api/classes/canvas/)、
[filter GPU memory](https://fabricjs.com/docs/old-docs/fabric-filters/)）。这会让 React Strict Mode
和频繁切换 Dockview panel 的生命周期测试更重要。

npm registry 的 `fabric` 7.4.0 发布包 unpacked size 约 21.2 MiB；该数字包含发布文件，
不等于最终 bundle，但明显大于 Konva 方案。Fabric 支持模块化 import，不过官方也警告
精简 import 与 `loadFromJSON`/SVG loading 的安全组合需要谨慎
（[Fabric 6 imports](https://fabricjs.com/docs/upgrading/upgrading-to-fabric-60/)、
[`fabric` registry](https://registry.npmjs.org/fabric/latest)）。

**判断：** 若后续需求升级为复杂图层/文字排版，可重新选择 Fabric；当前“图片预览 + 轻编辑”
更适合 React-Konva 的显式 React 19 binding 和较小集成面。

### 3. Filerobot Image Editor

Filerobot 是 MIT 的 React 成品编辑器，已有 resize、crop、flip、finetune、annotate、watermark、
filters、历史、设计状态保存和导出
（[官方仓库与文档](https://github.com/scaleflex/filerobot-image-editor)）。

但有三项阻断风险：

1. 稳定版文档仍只列 React 17/18 compatibility；npm 当前 `5.0.0-beta.159` 才把 peer
   dependencies 提升到 React 19，且版本本身仍是 beta
   （[`react-filerobot-image-editor` npm](https://www.npmjs.com/package/react-filerobot-image-editor)）。
2. 官方能力表没有 OCR，也没有面向**局部敏感信息遮挡**的马赛克/模糊选区工具。
3. 自带完整工具栏、保存弹窗、离开页面提示、主题与 UI 依赖。VibeX 要求底部原生工具栏，
   大幅换肤会削弱“接入成品”的收益，并引入两套命令和历史权威。

npm v5 beta 包自身 unpacked size 约 436 KiB，但还依赖 Konva、React-Konva、Styled Components
和 Scaleflex UI/icon 包，不能把这个数字当作总成本
（[registry metadata](https://registry.npmjs.org/react-filerobot-image-editor/latest)）。

**判断：** 不建议在主产品直接集成。可以做一次隔离原型验证，但不应成为当前实现基础。

### 4. TOAST UI Image Editor

TOAST UI 是功能覆盖最接近的单库：crop、drawing、shape、text、undo/redo、download 和
Pixelate filter 都存在，许可证为 MIT
（[官方仓库](https://github.com/nhn/tui.image-editor)）。

但 npm 主包已经约四年未发布；React wrapper 约五年未发布，并只声明 React `^17.0.2`
（[`tui-image-editor` npm](https://www.npmjs.com/package/tui-image-editor?activeTab=versions)、
[`@toast-ui/react-image-editor` npm](https://www.npmjs.com/package/%40toast-ui/react-image-editor?activeTab=dependencies)）。
它还固定依赖 Fabric 4.2，并默认包含使用统计能力；即使可以设置 `usageStatistics: false`，
本地优先产品也不值得基于这条老依赖链承担安全和 React 19 兼容维护。

**判断：** 淘汰，不 fork、不 patch。

### 5. Tesseract.js

Tesseract.js 是 Apache-2.0 的本地 OCR 引擎，浏览器端通过 Web Worker + WebAssembly 运行；
npm 当前 `7.0.0`。它能返回文本，并可启用 `blocks`/TSV/HOCR 等结构化输出；`blocks` 包含
文字位置，可用于在图片上绘制 OCR 选区
（[`tesseract.js` npm](https://www.npmjs.com/package/tesseract.js?activeTab=versions)、
[recognize API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)、
[v6 output change](https://github.com/naptha/tesseract.js/releases)）。它不支持手写识别，也不直接
支持 PDF；这次只处理图片，不构成阻断
（[官方 FAQ](https://github.com/naptha/tesseract.js/blob/master/docs/faq.md)）。

本地优先的关键点是**不能使用默认 CDN 路径**。官方文档说明浏览器版会启动 Worker，Worker
再加载 core 与 language files；未配置时 language/core 可从 CDN 获取。VibeX 应把
`workerPath`、`corePath`、`langPath` 全部指向随应用发布的本地资源
（[Local Installation](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)）。

体积与性能是主要风险：registry 中 `tesseract.js` unpacked size 约 1.35 MiB，
`tesseract.js-core` 约 29.2 MiB，此外还需要独立语言数据；这些仍不是单次实际下载量，因为
core 包含多个 WASM 变体，运行时会选择其一
（[`tesseract.js` registry](https://registry.npmjs.org/tesseract.js/latest)、
[`tesseract.js-core` registry](https://registry.npmjs.org/tesseract.js-core/latest)）。Worker 初始化
本身可能占 OCR 总耗时的大部分，因此应按需初始化、复用处理多张图片，并在最后一个图片标签页
关闭后终止；官方也建议多图复用同一个 worker
（[Performance](https://github.com/naptha/tesseract.js/blob/master/docs/performance.md)、
[官方 README](https://github.com/naptha/tesseract.js)）。

## 推荐落地路径

### 图片预览标签页

- Workspace 图片点击意图交给 Workspace 的 panel opener：以规范化绝对路径或 Artifact ID
  形成稳定 panel ID；已打开时聚焦，不重复创建。
- Kanban 点击仍进入弹窗预览，复用同一个只读 `ImageViewport`，而不是复制图片加载/缩放逻辑。
- 图片标签页首版只用普通 `<img>` / Canvas 查看层。只有用户首次进入编辑模式时才懒加载
  React-Konva；只有点击 OCR 时才加载 Tesseract Worker/WASM/语言包。
- 编辑文档保存源图 hash/revision、原始像素尺寸、操作列表和历史指针；视口缩放、平移不进入
  图片编辑历史。

### OCR

**推荐：Tesseract.js 7，本地静态资源，单 Worker 懒加载。**

- 首版只内置需求明确的语言数据，例如 `eng` 与 `chi_sim`，其他语言按本地可选资源安装；
  不随每次打开图片初始化全部语言。
- OCR 结果先作为独立 overlay/侧栏状态存在，不直接修改像素。用户可以复制全文、选择文字，
  或把识别框转为马赛克选区。
- 主要风险：首次加载与识别延迟、大图内存峰值、中文语言数据体积、各系统 WebView 的 Worker/
  WASM CSP。需要 macOS/Windows/Linux 真机验证，而不仅是 jsdom。

### 马赛克

**推荐：React-Konva 区域节点 + Pixelate filter，而不是全图滤镜。**

- 用户拖出矩形/自由选区后，从原始图片坐标裁出区域，创建不可编辑源像素的派生节点并应用
  Pixelate；把选区参数作为可撤销命令保存。
- 导出时统一以原图分辨率离屏重放操作，不能导出当前缩放后的屏幕 Canvas。
- 主要风险：高 DPI/缩放坐标漂移、多个马赛克区的缓存与 GPU/内存、裁剪后操作坐标迁移、
  JPEG 重编码造成边缘泄漏。对安全遮挡场景要提供“扁平化后预览”，并测试导出像素确实不可恢复。

### 裁剪

**推荐：React-Konva Transformer 选择框 + 原图坐标 crop command。**

- 裁剪在提交前只是预览遮罩；提交时更新非破坏性的 crop rectangle，后续操作都通过统一坐标
  变换层解释。
- 主要风险：裁剪、旋转、批注的操作顺序。必须定义单一操作管线，不允许工具各自修改底图并
  累积重采样。

### 批注

**推荐：React-Konva 的 Line、Arrow、Rect、Ellipse、Text 与 Transformer。**

- 批注保持向量对象；选择、移动、缩放、颜色、线宽和删除形成离散 history command。
- 文字编辑使用定位到 Canvas 文本框上的 DOM `<textarea>`，提交后回写 Konva Text；不要尝试
  在 Canvas 内重新实现完整输入法。
- 主要风险：IME/中文输入、字体可用性、跨平台文字度量、触控命中区域，以及大量自由画笔路径
  的性能。官方提醒向量自由绘制在数百/数千条路径后需要额外优化
  （[Free Drawing](https://konvajs.org/docs/react/Free_Drawing.html)）。

### 撤销、重做与导出

- 历史的唯一权威应是 VibeX 的编辑文档状态，不是 Konva 内部节点快照；连续拖动/画笔操作应
  合并成一次 command。
- 导出以 Blob/二进制写入新文件，默认“另存为”；覆盖源文件前比较打开时的 revision/hash，
  防止外部修改被静默覆盖。
- 用户离开有未保存修改的标签页时，复用 VibeX panel dirty-state/关闭确认，不采用第三方库的
  `beforeunload` 提示。

## 本地文件与 Tauri 安全

1. **不开放整个 Home 或 Workspace 的前端文件系统 scope。** Tauri 官方说明 capabilities
   用于限制每个窗口/WebView 的 IPC 暴露，过宽或多个 capability 会合并安全边界
   （[Capabilities](https://v2.tauri.app/security/capabilities/)）。图片读取/写入应通过已经解析
   的 Workspace/Artifact 身份和后端命令，或仅为用户选择的文件授予最小 scope。
2. **优先传递文件 bytes/Blob URL，而不是长期暴露绝对路径。** 创建的 object URL 在图片
   卸载后立即 revoke；导出结果也不把 base64 长期放进 React 状态或数据库。
3. **避免 Canvas taint。** Konva 官方说明跨域图片会使 `toDataURL()` 抛出安全错误
   （[Stage Data URL](https://konvajs.org/docs/data_and_serialization/Stage_Data_URL.html)）。本地
   文件统一通过受控 bytes/Blob 管线加载；未来支持远程图片时先下载为受信任本地产物，
   不直接把任意 URL 画进可导出的 Canvas。
4. **OCR 资源全部随应用发布。** 不在 CSP 中为 jsDelivr、unpkg 或任意远端开启 Worker/
   script/连接权限；只增加实际需要的本地 `worker-src`/WASM 配置。Tauri 文件系统插件默认
   阻止潜在危险命令，scope 应精确到允许路径，deny 优先于 allow
   （[Tauri File System Security](https://v2.tauri.app/plugin/file-system/)）。
5. **释放资源。** panel 关闭或换图时取消未完成解码/OCR，终止不再使用的 Worker，销毁
   Konva stage，清除图片缓存和 object URL；为超大图片设置像素/内存上限并显示可恢复错误。

## 是否应立即集成

**建议立即实现预览标签页骨架，但不要在同一轮直接承诺全部编辑功能，也不要先装一个成品
编辑器。** 骨架稳定后，按以下顺序交付：

1. 图片标签页、缩放/适应/旋转、另存为、dirty-state 与外部文件 revision 检查；
2. React-Konva 底座、统一坐标模型、历史与原图分辨率导出；
3. 裁剪与基础批注；
4. 区域马赛克，并增加导出像素安全测试；
5. Tesseract.js OCR 懒加载、本地语言资源和真机性能基线。

如果本次迭代只能安全完成路由差异和标签页，应该只交付可用的只读预览，不展示尚未实现的
OCR、马赛克、裁剪或批注按钮。完整编辑能力属于中等偏高难度：技术上可行，但需要独立的
坐标、历史、导出、安全和跨平台测试闭环。
