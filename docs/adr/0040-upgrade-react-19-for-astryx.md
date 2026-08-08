---
status: accepted
date: 2026-08-07
decision-makers:
  - VibeX maintainers
---

# 升级 React 19 作为 Astryx 采纳的前置门槛

## Context

VibeX 前端当前锁定 `react ^18.2.0` / `react-dom ^18.2.0`(实际 18.3.1)。
[ADR-0039](0039-adopt-astryx-for-chat-composer-and-message-rendering.md) 采纳 Astryx 组件库重构
会话输入体系,而 `@astryxdesign/core` 的 peerDependencies 为 `react >= 19.0.0`、
`react-dom >= 19.0.0`、`@stylexjs/stylex ^0.19.0` —— 不升级 React 19 无法安装使用。
ADR-0039 原文本称"React 19 升级已单独评估为安全可行",但仓库中不存在这份评估;
本 ADR 补齐该评估并作为升级的决策记录。

## 决策

将前端升级到 React 19(`react` / `react-dom` 升至 `^19`,`@types/react` /
`@types/react-dom` 同步升级),作为 Astryx 采纳的阶段 0 独立前置;升级后执行全量
类型检查、lint、前端测试与 `cargo check` 回归,通过后才进入 Astryx 阶段。

## 兼容性核对(2026-08-07,基于 pnpm-lock.yaml 与 npm registry)

| 依赖(当前版本) | peerDependencies | React 19 兼容 |
| --- | --- | --- |
| `lexical` / `@lexical/*` 0.36.2 | `react >= 17.x`、`react-dom >= 17.x` | ✅ |
| `react-markdown` 10.1.0 | `react >= 18` | ✅ |
| `cmdk` 1.1.1 | `react ^18 \|\| ^19` | ✅ |
| `@radix-ui/react-select` 2.2.5、`tooltip` 1.2.7 等 11 包 | `react ^16.8 \|\| ^17 \|\| ^18 \|\| ^19` | ✅ |
| `mermaid` / `katex` / `shiki` / `dompurify` / `marked` | 无 react peer | ✅ |

代码模式核查(前端 `src/`):已使用 `ReactDOM.createRoot`(React 18 入口,React 19
继续支持);无 legacy `ReactDOM.render`、无 string refs、无函数组件 `defaultProps`;
`forwardRef` 仅用于约 10 个 shadcn 风格封装(`components/ui/*.tsx`),React 19 中
`ref` 可作普通 prop 传递,`forwardRef` 仍可用 —— 不阻塞升级,可后续逐步简化。

测试环境:`@testing-library/react ^16.3.2`(支持 React 19)、`jsdom ^28.1.0`、
`vitest ^2.1.9` —— 无阻塞。

## Considered Options

- **不升级,维持 React 18**:被否决。Astryx peer 硬性要求 `react >= 19`;
  `liquid-glass-react` 等其他候选也已声明 `react >= 19`,React 19 升级势在必行。
- **双版本共存(React 18 主体 + Astryx 隔离挂载 React 19)**:被否决。
  同一 webview 内双 React 运行时带来 context/portal/事件系统分裂,维护成本远高于
  一次性升级,且与"单一真相源"原则冲突。
- **升级 React 19(采纳)**:依赖树与代码模式均已核实兼容,风险面收敛为类型层
  调整与回归验证。

## Consequences

- **类型层调整**:`@types/react` 19 下 `React.FC` 不再隐式提供 `children`;
  若有组件依赖该隐式类型需显式声明。`forwardRef` 组件可保留原样。
- **行为差异**:React 19 的严格模式双调用、ref cleanup 等变更可能暴露既有
  隐藏 bug,以全量测试回归兜底。
- **前置依赖**:升级完成后才能安装 `@astryxdesign/core`(阶段 1),本 ADR 与
  ADR-0039 阶段 0 的验收标准一致。

## 阶段 0 验收标准

1. `pnpm run check`(`tsc --noEmit` + `cargo check`)通过。
2. `cd frontend && pnpm test` 全部通过(无因 React 19 引发的失败)。
3. `pnpm run lint` 通过。
4. `pnpm run dev` 启动后核心流程(会话输入、消息渲染、工具调用、审批)冒烟通过。
5. 本仓库无 `react@18` 残留(lockfile 中 react/react-dom 均为 19.x)。
