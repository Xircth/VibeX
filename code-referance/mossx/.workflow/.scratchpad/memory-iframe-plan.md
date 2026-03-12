# 长期记忆 iframe 嵌入实现计划

## 需求
点击侧边栏"长期记忆"按钮后，在主内容区域（红框范围）用 iframe 加载 `http://localhost:37777/`，作为一个新的 content-layer（与 chat/diff/editor 同级）。

## 实现方案

### 核心思路
扩展现有的 `centerMode` 类型，新增 `"memory"` 模式。当 `centerMode === "memory"` 时，显示一个包含 iframe 的 content-layer。

### 修改文件清单

#### 1. `useGitPanelController.ts` — 扩展 centerMode 类型
- 将 `"chat" | "diff" | "editor"` 改为 `"chat" | "diff" | "editor" | "memory"`
- 影响范围：useState 初始化处（第 31 行）

#### 2. `AppLayout.tsx` — 传递 centerMode 新类型
- 更新 `centerMode` 的类型定义（第 15 行）

#### 3. `DesktopLayout.tsx` — 添加 memory content-layer
- 更新 `centerMode` 的类型定义（第 15 行）
- 添加 `memoryLayerRef`
- 在 content div 中添加新的 memory content-layer（包含 iframe）
- 更新 useEffect 中的 layers 数组，加入 memory layer

#### 4. `SidebarMarketLinks.tsx` — 接收并调用 setCenterMode
- 接受 `onOpenMemory` 回调 prop
- 长期记忆按钮的 onClick 调用 `onOpenMemory` 而非 `handleClick`

#### 5. `Sidebar.tsx` — 传递 onOpenMemory prop
- 在 SidebarProps 中添加 `onOpenMemory`
- 传递给 `<SidebarMarketLinks onOpenMemory={onOpenMemory} />`

#### 6. `App.tsx` — 连接 setCenterMode("memory") 到 Sidebar
- 创建 `handleOpenMemory` 回调：`setCenterMode("memory")`
- 传递给 sidebarNode 中的 Sidebar 组件

#### 7. `main.css` — 无需修改
- `.content-layer` 的 is-active/is-hidden 样式已经通用，新增 layer 直接复用

### 数据流
```
用户点击"长期记忆"按钮
  → SidebarMarketLinks.onOpenMemory()
  → Sidebar.onOpenMemory()
  → App.tsx: setCenterMode("memory")
  → AppLayout.centerMode="memory"
  → DesktopLayout: memory content-layer 显示 is-active
  → iframe 加载 http://localhost:37777/
```

### 返回聊天的方式
- 用户点击 MainTopbar 中的返回按钮，或
- 选择一个会话线程时自动切回 `setCenterMode("chat")`
- 现有代码中已有 `setCenterMode("chat")` 的调用点（第 2471、2686 行），会在用户操作时自动切回
