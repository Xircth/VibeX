# VibeUltra 依赖冗余分析报告

> 分析日期: 2026-03-16 (第二轮)
> 审查范围: `frontend/package.json`、`src-tauri/Cargo.toml`、各 `crates/*/Cargo.toml`
> 总体评级: **警告**

---

## 一、前端零使用/可移除依赖

### 1.1 立即可移除

| 依赖 | 类型 | 预估节省 | 说明 |
|------|------|----------|------|
| `@ibm/plex` | devDep | **~30MB node_modules** | 字体已本地化为 woff2 在 `public/fonts/`，npm 包纯冗余 |
| `@tailwindcss/container-queries` | dep | 极小 | Tailwind 配置中注册但零 `@container` 使用 |

### 1.2 需确认后移除

| 依赖 | 说明 |
|------|------|
| `@tauri-apps/plugin-shell` | 前端零导入，可能仅 Rust 侧使用 |
| `react-compiler-runtime` | React Compiler 运行时，由 babel 插件自动注入。若未启用 React Compiler 则可移除 |

---

## 二、功能重叠依赖组

### 2.1 [关键] 图标库 -- 三库并存

| 库 | 使用次数 | 包体积 |
|----|---------|--------|
| `lucide-react` | **134 处** (133 文件) | ~200KB (tree-shakable) |
| `@phosphor-icons/react` | **4 处** (3 文件) | ~500KB (tree-shakable) |
| `developer-icons` | **1 处** (1 文件) | 未知 |

**建议**: 统一到 `lucide-react`，仅需修改 3-4 个文件。预估节省 **~500KB+**。

### 2.2 [高] 代码编辑器 -- 三套方案

| 库 | 用途 | 使用位置 |
|----|------|---------|
| `@uiw/react-codemirror` + 4 个 `@codemirror/*` 包 | JSON 编辑器 | 仅 1 文件 (`json-editor.tsx`) |
| `monaco-editor` + `@monaco-editor/react` | 代码预览/Diff | 2 文件 |
| `prismjs` | 语法高亮 | 仅 1 文件 (`syntax.ts`) |

**建议**: 移除 CodeMirror 全套（5 个包），用 Monaco 实现 JSON 编辑。预估节省 **~300KB**。

### 2.3 [中] Diff 渲染 -- 三套方案

| 库 | 使用位置 |
|----|---------|
| `@git-diff-view/react` + `@git-diff-view/file` | 3 文件 |
| `@pierre/diffs` | 1 文件 (`diffDataAdapter.ts`) |
| Monaco 内置 diff | 1 文件 |

### 2.4 [低] dockview 三包

| 包 | 导入次数 |
|----|---------|
| `dockview-react` | 16 处（主要使用） |
| `dockview-core` | 1 处（类型导入） |
| `dockview` | 1 处（类型导入） |

检查 `dockview-react` 是否 re-export 所需类型。

---

## 三、使用极少可替代的依赖

| 依赖 | 使用次数 | 替代方案 | 预估节省 |
|------|---------|----------|----------|
| `framer-motion` | 3 处 | CSS transitions/animations | ~150KB |
| `@tanstack/react-form` | 1 处 | 简单 useState | ~30KB |
| `react-resizable-panels` | 1 处 | dockview 已有布局能力 | ~20KB |
| `embla-carousel-react` | 1 处 | CSS scroll-snap | ~15KB |
| `react-dropzone` | 1 处 | HTML5 drag & drop API | ~10KB |

---

## 四、依赖分类错误

### 应从 devDependencies 移到 dependencies

| 依赖 | 原因 |
|------|------|
| `@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8` | 在 10 个运行时文件中被导入，不是纯开发工具 |

### 应从 dependencies 移到 devDependencies

| 依赖 | 原因 |
|------|------|
| `tailwind-scrollbar` | Tailwind 插件，仅构建时使用 |
| `tailwindcss-animate` | Tailwind 插件，仅构建时使用 |

---

## 五、Rust 依赖分析

### 5.1 应提升为 workspace 依赖

| Crate | 出现次数 | 备注 |
|-------|---------|------|
| `sqlx` | **7 处** | features 不一致（关键问题） |
| `dirs` | 6 处 | |
| `tokio-util` | 4 处 | features 不同 |
| `tempfile` | 4 处 | |
| `tokio-stream` | 3 处 | features 不同 |
| `command-group` | 3 处 | |
| `strum` / `strum_macros` | 3 处 | |
| `regex` | 3 处 | |
| `enum_dispatch` | 2 处 | |
| `rust-embed` | 2 处 | |
| `shlex` | 2 处 | |
| `base64` | 2 处 | |
| `ignore` | 2 处 | |
| `which` | 2 处 | |
| `toml` | 2 处 | |
| `json-patch` | 2 处 | |

### 5.2 sqlx features 不一致（关键）

```
db/services/local-deployment: ["runtime-tokio", "tls-rustls-aws-lc-rs", "sqlite",
                                "sqlite-preupdate-hook", "chrono", "uuid"]
src-tauri:                     ["runtime-tokio", "sqlite"]  -- 缺少多个 features
executors/api-types:           [default-features=false, "derive"]  -- 最小化
deployment:                    [default-features=false]  -- 最小化
```

Cargo 自动合并 features，造成隐式依赖。应统一到 workspace 层面。

### 5.3 功能重叠

| 重叠组 | 说明 |
|--------|------|
| `dirs` + `directories` + `xdg` | 三个目录路径库共存。`dirs`(6 crate) + `directories`(utils) + `xdg`(executors,1处) |

**建议**: 统一使用 `dirs`。

### 5.4 经验证有使用的依赖

所有其他 Rust 依赖（`base64`、`trash`、`ignore`、`os_info`、`which`、`ts-rs`、`jsonwebtoken`、`similar`、`shellexpand`、`rust-embed`、`url`、`notify-rust`、`backon`、`dashmap`、`dunce`、`sha2`、`fst`、`moka`、`walkdir`、`rand`、`lru`、`derivative`、`convert_case`、`eventsource-stream`、`jsonc-parser`、`globwalk`、`portable-pty` 等）均有实际使用。

---

## 六、行动优先级

| 优先级 | 操作 | 预估时间 | 预估收益 |
|--------|------|----------|----------|
| P0 | 移除 `@ibm/plex` | 1 分钟 | -30MB node_modules |
| P0 | 统一 sqlx 为 workspace 依赖 | 30 分钟 | 消除隐式依赖风险 |
| P0 | 修正 `@rjsf/*` 分类 (devDep -> dep) | 5 分钟 | 修复潜在构建问题 |
| P1 | 统一图标库到 lucide-react | 1 小时 | -500KB bundle |
| P1 | 提升 15+ Rust 依赖为 workspace 依赖 | 1 小时 | 版本统一管理 |
| P2 | 移除 CodeMirror 全套 | 2 小时 | -300KB bundle |
| P2 | 移除 framer-motion | 1 小时 | -150KB bundle |
| P2 | 移动 tailwind 插件到 devDep | 5 分钟 | 分类正确 |
| P3 | 移除 `@tailwindcss/container-queries` | 5 分钟 | 清理 |
| P3 | 评估移除 dockview/dockview-core | 30 分钟 | 可能减少包体积 |
| P3 | 评估 diff 渲染库合并 | 2 小时 | 减少维护负担 |
| P3 | 统一 dirs/directories/xdg | 1 小时 | 减少 Rust 依赖 |
