# Composer 弹窗问题修复落盘（2026-02-10）

## 背景
`Composer` 管理区的 `? / S+ / M+` 按钮弹窗在部分改动后出现“点击无可见反馈/弹窗不显示”的问题。

---

## 结论先行
本次问题不是单一 CSS 一行导致，而是两层原因：

1. **首轮误判**：仅删除 `.composer-management-panel` 的 `overflow: hidden` 不足以彻底修复。
2. **真实风险链路**：弹层放在局部布局树内，祖先容器 `overflow` 后续再改会再次裁剪。

最终采用了两阶段处理：
- 阶段 A（止血）：解除当前容器裁剪。
- 阶段 B（稳健）：将三个菜单改为 **Portal 弹层组件**，从祖先 `overflow` 链路脱离。

---

## 根因复盘

### 1) 文档初版根因已过期
初版计划把根因写成 `.composer-management-panel (overflow: hidden)`。

但实际代码中该行已被删除，问题仍可能发生。

### 2) 当前结构真实脆弱点
弹层在 `Composer.tsx` 中以内联方式渲染在管理区内，受祖先布局上下文影响。
即便当前能显示，后续他人对祖先 `overflow / transform / stacking context` 的调整，仍可能让弹层再次被裁剪。

---

## 已实施变更

### A. 止血修复（CSS）
文件：`src/styles/composer.css`

1. 保留了已删除的这行（来自前序修复）：
- `.composer-management-panel` 不再有 `overflow: hidden`。

2. 调整管理头部溢出策略：
- `.composer-management-header` 从 `overflow-x: auto; overflow-y: hidden;`
- 改为 `overflow: visible;`

目的：避免弹窗向上展开时被当前头部容器裁剪。

---

### B. 稳健化重构（独立 Portal 组件）

#### 1) 新增独立组件
文件：`src/features/composer/components/ComposerContextMenuPopover.tsx`

能力：
- 使用 `createPortal` 渲染到 `document.body`
- 基于 `anchorRef` 动态定位
- `Esc` 关闭
- 点击 backdrop 关闭
- 监听 `resize/scroll` 自动重算位置
- 上下空间不足时自动选择 top/bottom

#### 2) Composer 菜单接线（最小侵入）
文件：`src/features/composer/components/Composer.tsx`

改动范围：仅替换 `? / S+ / M+` 三个菜单的弹层渲染方式。

保持不变：
- 原有 open/close 状态
- 搜索输入与过滤逻辑
- option 分组渲染逻辑
- pick 行为与关闭行为

#### 3) Portal 样式变体
文件：`src/styles/composer.css`

新增：
- `.composer-context-menu-panel--portal { position: fixed; bottom: auto; }`

目的：覆盖原绝对定位弹层，使 Portal 弹层使用视口固定定位。

---

## 测试与验证

### 1) 新增回归测试（防后续误改）
文件：`src/features/composer/components/ComposerContextMenuPopover.test.tsx`

覆盖用例：
1. `Escape` 可关闭弹层
2. 点击 backdrop 可关闭弹层

执行结果：
- `npm run test -- src/features/composer/components/ComposerContextMenuPopover.test.tsx`
- 通过（2/2）

### 2) 静态校验
- `npm run typecheck`：通过
- `npm run lint`：通过（仅仓库既有 warning，无新增 error）

---

## 影响面评估

### 正向收益
1. 菜单显示不再依赖局部容器 `overflow` 状态。
2. 对未来 UI 重构更稳健，降低“替代式改坏”概率。
3. 通过新增测试将关闭行为纳入回归保护。

### 已知边界
1. 当前新增测试聚焦交互关闭行为（Esc / backdrop）。
2. 视觉定位细节（像素级）未做快照测试（有意规避脆弱测试）。

---

## 本次改动文件清单

1. `src/features/composer/components/ComposerContextMenuPopover.tsx`（新增）
2. `src/features/composer/components/ComposerContextMenuPopover.test.tsx`（新增）
3. `src/features/composer/components/Composer.tsx`（接入 Portal）
4. `src/styles/composer.css`（止血 + Portal 样式）
5. `docs/plans/2026-02-10-composer-popup-fix.md`（本落盘文档）

---

## 回滚说明
如需快速回退本次稳健化：

```bash
git checkout -- src/features/composer/components/Composer.tsx
git checkout -- src/styles/composer.css
git checkout -- src/features/composer/components/ComposerContextMenuPopover.tsx
git checkout -- src/features/composer/components/ComposerContextMenuPopover.test.tsx
```

---

## 备注
本次处理遵循“最小影响原则”：
- 业务逻辑未改；
- 仅替换弹层渲染层；
- 增加最小必要测试，确保后续改动可被及时发现。

---

## 新增：窄窗自动展开策略（本轮）

### 目标
当窗体缩小时，避免管理区元素挤压导致可操作性下降；在窄宽度下自动展开管理区，不再依赖用户手动点“管理面板”。

### 实现方案

#### 1) 容器宽度驱动的自适应开关
文件：`src/features/composer/components/Composer.tsx`

- 新增状态：`isCompactLayout`
- 通过 `ResizeObserver` 监听管理区关键元素尺寸（panel/header/actions/toggle）
- 使用内容驱动判定：`actions.scrollWidth + toggleWidth + 预留间距` 是否超过 `headerWidth`
- 仅当内容真实溢出时进入 compact 模式（不再依赖固定像素阈值）

#### 2) 折叠逻辑改为“手动状态 + 自适应覆盖”
文件：`src/features/composer/components/Composer.tsx`

- 原状态：`contextCollapsed`
- 新结构：
  - `manualContextCollapsed`（最终显示状态，始终可手动切换）
  - `isCompactLayout`（仅表示当前是否处于紧凑布局）
  - `previousCompactLayoutRef`（识别“首次进入 compact”）

效果：
- 首次进入 compact：自动展开一次，避免功能入口被挤压
- 进入 compact 后：用户仍可点击“管理面板”手动折叠/展开
- 退出 compact：保留用户最后一次手动状态

#### 3) 窄窗下折叠按钮行为
文件：`src/features/composer/components/Composer.tsx`

- 保持“管理面板”按钮始终可点击
- 不再在 compact 下禁用按钮

#### 4) 窄窗布局优化样式
文件：`src/styles/composer.css`

新增：
- `.composer-management-panel.is-compact .composer-management-header { flex-wrap: wrap; row-gap: 6px; }`
- `.composer-management-panel.is-compact .composer-management-toggle { margin-left: 0; }`

作用：在窄窗下让头部自然换行，避免一条线上拥挤。

### 验证结果（本轮）

1. `npm run typecheck`：通过
2. `npm run lint`：通过（仅仓库既有 warning）
3. `npm run test -- src/features/composer/components/ComposerContextMenuPopover.test.tsx src/features/composer/components/ComposerEditorHelpers.test.tsx`：通过（6/6）

### 与前序修复关系

- 该策略是 **UX 可用性增强层**。
- 仍与 Portal 稳健化互补：
  - Portal 解决“不会被裁剪”
  - 自适应展开解决“窄窗不拥挤、按钮可操作”

---

## 新增：代码清洗记录（本轮）

### 清洗目标
在不改变行为的前提下，提升可读性与可维护性，清理本次修复过程中引入的冗余实现细节。

### 已完成清洗

1. `Composer.tsx`：提取 compact 判定中的预留间距常量
- 新增：`COMPOSER_COMPACT_RESERVED_GAP`
- 避免魔法数字散落在 effect 内

2. `Composer.tsx`：整理 `ResizeObserver` 观测逻辑
- 将重复 `if (...) observer.observe(...)` 整理为单一循环
- 保持观测对象与原行为一致

3. `composer.css`：移除无效样式
- 清理已不再使用的 `.composer-management-toggle:disabled`

### 清洗后验证

1. `npm run typecheck`：通过
2. `npm run lint`：通过（仅仓库既有 warning）
3. `npm run test -- src/features/composer/components/ComposerContextMenuPopover.test.tsx src/features/composer/components/ComposerEditorHelpers.test.tsx`：通过（6/6）

### 结论
本轮仅做结构性提纯，无行为变更，功能路径与交互结果保持不变。

---

## 新增：Kanban 显示优化（本轮）

### 目标
1. 在 `kanban` 数量较多时节省横向空间。  
2. `kanban` 在 Composer 中按创建时间倒序展示（最新在前）。

### 实施内容

1. Link 按钮去文案，仅保留 icon
- 文件：`src/features/composer/components/Composer.tsx`
- 改动：展开态与折叠态两个看板条目中的 link 按钮，移除文字节点，仅保留 `ExternalLink` icon
- 可访问性：新增 `aria-label`，例如 `"<panelName> link"`，避免只剩 icon 后语义缺失

2. 看板按创建时间倒序
- 文件：`src/App.tsx`
- 改动：`composerLinkedKanbanPanels` 从按 `sortOrder` 改为按 `createdAt` 倒序
- 排序策略：`b.createdAt - a.createdAt || a.sortOrder - b.sortOrder`
- 同时透传 `createdAt` 字段到 Composer 链路

3. 类型同步
- 文件：`src/features/composer/components/Composer.tsx`
- 文件：`src/features/layout/hooks/useLayoutNodes.tsx`
- 改动：`linkedKanbanPanels / composerLinkedKanbanPanels` 类型增加 `createdAt?: number`

4. 样式压缩
- 文件：`src/styles/composer.css`
- 改动：`composer-kanban-strip-link` 设为 icon-only 紧凑样式（固定宽度、居中、去 gap）

### 验证
1. `npm run typecheck`：通过  
2. `npm run lint`：通过（仅仓库既有 warning）  
3. `npm run test -- src/features/composer/components/ComposerContextMenuPopover.test.tsx src/features/composer/components/ComposerEditorHelpers.test.tsx`：通过（6/6）
