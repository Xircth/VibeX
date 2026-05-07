# cc-gui 竞品分析与可吸纳能力

## 结论

cc-gui 的核心优势不是单点 Agent 能力，而是把 AI 开发流程沉淀为 Trellis 工作流：任务、PRD、代码规范、检查、复盘、知识沉淀形成闭环。VibeX 当前在桌面化工作区、多 Agent 任务并行、Git Worktree、会话与预览整合上更完整，但需要补强“项目知识如何被持续注入并更新”的产品层表达。

如果我是 cc-gui 用户，迁移到 VibeX 的关键理由会是：更强的多任务并行、原生桌面工作区、Claude Code/OpenCode/Codex 统一入口、Git 与预览的集中管理。阻碍迁移的点会是：我需要确认 VibeX 是否能像 Trellis 一样稳定地保存项目规范、任务 PRD、会话总结和复盘经验，并在下一次编码时自动带入。

## 可借鉴方向

1. 项目知识系统
   - cc-gui 通过 `.trellis/spec/` 保存包级规范、通用指南、测试约定和跨层契约。
   - VibeX 可以把现有 AGENTS/skills/MCP 配置包装成“项目知识库”视图，让用户知道每次 Agent 执行会读取哪些规则。

2. 任务生命周期
   - cc-gui 强调 `start -> brainstorm -> before-dev -> implement -> check -> finish-work -> record-session`。
   - VibeX 可以在任务详情页增加轻量阶段状态：需求、实现、验证、提交、复盘，而不是只展示对话与进程。

3. 代码规范注入
   - cc-gui 的 `before-dev` 和 `check` 让 Agent 在写代码前后都读取规范。
   - VibeX 可以增加“执行前上下文预检”和“提交前 Agent 自检”按钮，自动读取 AGENTS.md、README、docs、lint/test 命令和最近变更。

4. 复盘与知识回写
   - cc-gui 的 `break-loop`、`update-spec`、`record-session` 会把踩坑经验写回规范或日志。
   - VibeX 可以在任务结束后生成“经验卡片”：问题根因、修复方式、相关文件、验证命令、下次注意事项，并允许用户一键写入项目记忆。

5. 复杂需求的收敛能力
   - cc-gui 的 `brainstorm` 强制先创建 PRD，并通过一个问题一个问题收敛 MVP。
   - VibeX 可以把复杂任务的 prompt 增强升级为结构化 PRD 生成器，输出目标、范围、验收标准、风险和测试计划。

## cc-gui skills 能力清单

| Skill | 能力 | VibeX 是否可吸纳 |
| --- | --- | --- |
| `start` | 初始化会话，读取工作流、开发者身份、git 状态、当前任务和项目规范，并按任务复杂度路由。 | 可吸纳为“任务启动检查”。 |
| `brainstorm` | 创建任务目录和 PRD，先研究代码再提问，收敛需求和 MVP 范围。 | 可吸纳为复杂任务的 PRD 模式。 |
| `before-dev` | 开发前读取 `.trellis/spec/` 中对应包和类型的规范。 | 可吸纳为执行前上下文注入。 |
| `check` | 基于 git diff 找到改动文件，读取相关规范，运行 lint/typecheck 并检查违规。 | 可吸纳为任务完成前自动检查。 |
| `check-cross-layer` | 跨层验证数据流、复用、导入路径、常量一致性和遗漏更新点。 | 很适合 VibeX 的前后端/Rust/TS 混合项目。 |
| `improve-ut` | 根据改动文件和测试规范补充单元测试。 | 可作为“补测试”快捷动作。 |
| `finish-work` | 提交前质量门禁，覆盖 lint、typecheck、tests、spec 同步、API/DB/手测。 | 可吸纳为提交前 Checklist。 |
| `break-loop` | Bug 修复后做根因、失败修复、预防机制、扩展排查、知识沉淀。 | 可吸纳为“修复后复盘”。 |
| `update-spec` | 将实现、调试、设计决策和跨层契约写回规范。 | 可吸纳为项目知识更新入口。 |
| `record-session` | 人工测试和提交后记录会话总结、commit hash 和后续上下文。 | 可吸纳为会话归档。 |
| `create-command` | 创建新 workflow skill 的脚手架。 | 可作为 VibeX skill 管理功能。 |
| `integrate-skill` | 把外部 skill 融入项目规范和模板。 | 可吸纳为 skill 导入/本地化。 |
| `onboard` | 新成员交互式了解 Trellis AI 工作流。 | 可吸纳为项目/团队入门向导。 |

## 优先级建议

P0：把项目知识库、执行前上下文预检、提交前检查做成 VibeX 内置工作流。这能直接提高 Agent 产出稳定性。

P1：增加任务 PRD/验收标准/验证命令的结构化视图，让多 Agent 并行不只是“多个进程”，而是围绕同一份任务契约执行。

P2：增加会话复盘和知识回写，让用户从“这次修好了”升级到“以后同类问题少发生”。

P3：支持 skill 导入和本地化，把 cc-gui/Trellis 风格 workflow 转成 VibeX 可执行的任务模板。
