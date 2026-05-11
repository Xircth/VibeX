# cc-gui 竞品分析与 VibeX 可吸纳能力

> 分析对象：`code-referance/cc-gui`
>
> 备注：用户提到的 `.agent/skills` 在该项目中实际目录为 `.agents/skills`。以下 skills 分析基于这个目录。

## 结论摘要

cc-gui 的核心竞争力不是某一个 Agent 能力，而是把 AI 编程过程包装成一套可反复执行的工程工作流：会话启动、需求收敛、规范注入、实现、检查、收尾、复盘、知识沉淀。它通过 `.trellis/spec`、`.trellis/tasks`、`.agents/skills`、Project Memory、Prompt Library、Context Ledger 等模块，把“AI 应该记住什么、什么时候检查、如何把经验写回项目”做成了产品和约束。

VibeX 当前的核心优势更接近“AI 编程任务工作台”：围绕 Claude Code、OpenCode、Codex 三类 Agent，提供项目、工作区、worktree、会话、终端、预览、代码变更和 Git 操作的统一管理。VibeX 的差异化基础更扎实，尤其是多任务并行、worktree 隔离、任务视图、开发服务器预览、点击元素作为上下文、MCP 与本地 Agent 配置管理。

如果我是 cc-gui 用户，愿意切换到 VibeX 的理由会是：

- VibeX 更聚焦 Claude Code、OpenCode、Codex 三个真实高频 Agent，而不是追求广泛但分散的 Provider 列表。
- VibeX 的 worktree 和任务执行模型更适合并行开发、审查、回滚和合并。
- VibeX 把预览、Diff、Git、终端和 Agent 会话放在同一个任务上下文中，真实开发链路更连贯。

阻止我切换的主要顾虑会是：

- VibeX 是否能像 cc-gui/Trellis 一样稳定保存项目规范、任务 PRD、检查清单、会话复盘和长期经验。
- VibeX 是否能在每次执行前自动注入正确上下文，而不是依赖用户手动提醒 Agent。
- VibeX 是否有足够明确的质量门禁，让多 Agent 并行不只是“同时跑多个进程”，而是围绕同一任务契约协作。

因此，VibeX 最值得吸纳的不是 cc-gui 的表层功能数量，而是它的“项目知识闭环”和“任务生命周期约束”。

## 产品定位对比

| 维度 | cc-gui | VibeX | VibeX 可学习点 |
| --- | --- | --- | --- |
| 核心定位 | 面向 AI 编程的桌面 GUI，强调 Claude/Codex/OpenCode 等 CLI 的统一操作与增强工作流 | 面向 AI 编程任务的桌面工作台，聚焦 Claude Code、OpenCode、Codex | 保持 VibeX 聚焦，不需要跟随 cc-gui 支持 Gemini 或更多泛 Provider |
| 主要价值 | 把 Trellis 式工作流、Project Memory、Prompt Library、Skills、质量门禁产品化 | 把任务、worktree、会话、终端、预览、Diff、Git 操作收束在一个本地工作台 | 在现有任务/worktree 基础上补“知识与流程层” |
| 用户心智 | “AI 编程 IDE/助手面板” | “多 Agent 任务执行与审查工作台” | 强化“任务从需求到合并”的完整闭环叙事 |
| 技术重心 | Tauri + React 前端，功能模块非常多，流程和前端工具链复杂 | Rust workspace + React/Tauri，后端任务、执行器、DB、Git、服务层拆分更工程化 | 用 VibeX 的后端结构承接 cc-gui 的 workflow 能力，而不是只做前端面板 |
| 风险 | 功能面很宽，可能产生复杂度、维护成本和使用噪音 | 当前文档、项目记忆、规范注入、复盘沉淀还不够产品化 | 吸收流程能力，但避免引入过重仪式感 |

## 功能对比与借鉴方向

| 功能域 | cc-gui 表现 | VibeX 现状 | 建议 |
| --- | --- | --- | --- |
| Agent 支持 | Claude Code、Codex、OpenCode、Gemini、Custom Providers 等 | 聚焦 Claude Code、OpenCode、Codex | 不建议扩展到 Gemini；应把三类 Agent 的本地配置、模型、权限、MCP 和日志做深 |
| 任务生命周期 | Trellis 将需求、PRD、上下文、检查、完成、记录串成工作流 | VibeX 有任务、会话、工作区、follow-up、review 等结构，但流程约束弱一些 | 增加任务阶段：需求、执行前上下文、实现、验证、提交、复盘 |
| 项目知识 | `.trellis/spec` + Project Memory + session record | 有 AGENTS.md、docs、workspace notes、skills discovery、MCP 配置，但缺统一“知识库视图” | 做 Project Knowledge 面板，展示 Agent 会读取的规则、skills、docs、MCP、历史复盘 |
| Prompt 管理 | Prompt Library，可保存与复用 prompt | VibeX 有 prompt enhancement、自定义 commit/PR prompt、slash commands | 增加 Prompt Library，和任务类型、Agent 类型、项目规则绑定 |
| Skills 系统 | `.agents/skills` 工作流技能完整，覆盖 start/brainstorm/check/finish/record | VibeX 有本地 Agent skills 列表能力，但产品化不足 | 增加 skill 导入、启用、说明、执行前注入、任务模板化 |
| 质量门禁 | doctor、runtime contract、large file、lint/typecheck/test、finish-work | 有 pnpm check、backend check、generate types、Rust tests 等命令 | 在 UI 中提供任务级 Quality Gate，并按变更类型推荐命令 |
| Context Ledger | 有上下文账本、投影、检查、Markdown 生成等工具 | VibeX 上下文更多散落在会话、prompt、notes、docs 中 | 建立“本次任务上下文包”：需求、相关文件、规范、历史、点击元素、验证命令 |
| Project Memory | 语义分类、手动注入、输出摘要、marker 机制 | VibeX 有 workspace notes，但不够结构化 | 引入记忆类型、作用域、注入策略和复盘写回 |
| 并行执行 | 有 parallel workspace 能力 | VibeX 的 worktree/任务模型更适合并行 | VibeX 应把并行做成强卖点：每个 Agent 每个任务独立 worktree + 汇总审查 |
| 预览与点击元素 | cc-gui 有 live edit preview 相关模块 | VibeX 已有 preview proxy、click-to-component、Preview Inspector | 这是 VibeX 的优势，应加强可靠性、React/Vite/Next 兼容与上下文插入体验 |
| 全局搜索 | cc-gui README 强调 8 类结果全局搜索 | VibeX 有搜索组件和任务/文件/会话数据，但统一搜索心智可加强 | 增加跨项目、任务、会话、文件、skills、MCP、docs 的统一命令面板 |
| 语音输入 | cc-gui 有 Whisper dictation | VibeX 暂无明显同等能力 | P2/P3 功能；适合长 prompt 用户，但不应优先于工程闭环 |
| Computer Use | cc-gui 有授权、平台适配、contract tests | VibeX 暂无明显同等能力 | 可作为未来高级能力，但要谨慎处理权限、安全和可验证性 |
| 自动更新/i18n | cc-gui 有 updater、i18next | VibeX 目前重点是核心工作流 | 桌面产品成熟后补齐，不应抢占核心工作流优先级 |

## VibeX 最值得借鉴的设计

### 1. 把“项目规则”做成可见、可检查、可注入的产品能力

cc-gui 的 `.trellis/spec` 不只是文档目录，而是 Agent 工作流的一部分。`before-dev` 会在开发前读取相关规范，`check` 会在开发后根据变更文件回查规范。这解决了 AI 编程中常见的问题：Agent 知道有规则，但不一定在正确时间读取。

VibeX 可以把 AGENTS.md、README、docs、MCP 配置、本地 Agent skills、workspace notes、历史任务复盘统一包装成“项目知识库”。每次新建任务时，VibeX 可以展示：

- 本任务会自动注入哪些项目规则。
- 哪些规则来自 AGENTS.md，哪些来自 docs，哪些来自用户手动 notes。
- 哪些 MCP Server 和 Agent skills 会参与。
- 哪些历史任务和复盘可能相关。

### 2. 给任务增加明确生命周期，而不是只展示会话

cc-gui 的 workflow 明确区分 start、brainstorm、before-dev、implement、check、finish-work、record-session。这个分层对复杂任务很有价值。

VibeX 可以在任务详情中增加轻量阶段：

- `需求`：目标、范围、验收标准、排除项。
- `上下文`：相关文件、规则、skills、MCP、历史复盘。
- `执行`：Agent 会话、终端、日志。
- `验证`：lint、typecheck、test、preview、manual QA。
- `提交`：diff、commit、push、PR 描述。
- `复盘`：问题根因、经验卡片、可写回项目知识库的条目。

这不需要强制所有用户填写长 PRD。简单任务可以自动生成极简需求卡，复杂任务再展开。

### 3. 把检查从“用户自己记得跑命令”升级为任务级 Quality Gate

cc-gui 的 `finish-work` 和 `check` 把 lint、typecheck、tests、spec 同步、API/DB 变更、手测等组织成收尾检查。VibeX 已经有更强的任务和 Git 语境，可以做得更自然：

- 根据变更文件自动建议验证命令。
- 前端变更建议 `pnpm run check`、lint、预览截图。
- Rust 后端变更建议 `pnpm run backend:check`、相关 `cargo test`。
- shared type 变更建议 `pnpm run generate-types`。
- DB 变更建议 `pnpm run prepare-db`。
- Tauri command 变更提示同步前端 API wrapper。

这比单纯提供终端更有产品价值。

### 4. 引入复盘写回，形成长期收益

cc-gui 的 `break-loop`、`update-spec`、`record-session` 价值很高。它们让一次 bug 修复不仅止于“修好了”，还会沉淀为以后可复用的规则。

VibeX 可以做“经验卡片”：

- 问题现象。
- 根因。
- 修复点。
- 失败过的方案。
- 相关文件。
- 验证命令。
- 下次类似任务应该自动提醒的规则。

用户确认后，经验卡片可以写入项目知识库，并在后续任务上下文中被自动召回。

### 5. 将 skills 变成项目可复用工作流模板

cc-gui 的 skills 本质是“面向 AI Agent 的 SOP”。VibeX 不应只是列出本地 skills 文件，而应支持：

- 查看 skill 的触发场景、输入、输出、风险。
- 将 skill 绑定到任务类型，例如 bugfix 自动建议 `break-loop`。
- 将外部 skill 导入后转为 VibeX 任务模板。
- 将 skill 执行结果与任务阶段、验证结果、复盘记录关联。

## `.agents/skills` 能力分析

| Skill | cc-gui 中的能力 | 对 VibeX 的价值 | 是否建议吸纳 | VibeX 吸纳方式 |
| --- | --- | --- | --- | --- |
| `start` | 初始化 AI 开发会话，读取 workflow、开发者身份、git 状态、当前任务、项目规范，并按任务复杂度路由 | 帮用户每次开始任务时自动获得正确上下文 | 建议 P0 吸纳 | 做成“任务启动检查”：读取项目规则、当前 git/worktree 状态、可用 Agent、MCP、skills |
| `brainstorm` | 复杂需求澄清，创建任务目录和 PRD，先研究代码再提问，逐步收敛 MVP | 让复杂需求不会直接进入混乱实现 | 建议 P0/P1 吸纳 | 做成“需求澄清/PRD 模式”：自动生成目标、范围、验收标准、技术约束 |
| `before-dev` | 开发前从 `.trellis/spec` 读取相关规范和检查清单 | 解决 Agent 忘读规则的问题 | 建议 P0 吸纳 | 做成“执行前上下文包”：按文件/任务类型选择 AGENTS、docs、skills、notes |
| `check` | 根据 git diff 找变更文件，读取相关规范，运行 lint/typecheck 并检查违规 | 适合 VibeX 的任务收尾和 review | 建议 P0 吸纳 | 做成“任务检查”按钮，结合 worktree diff 自动推荐检查项 |
| `check-cross-layer` | 检查跨层数据流、复用、导入路径、常量一致性和遗漏更新 | VibeX 是 Rust/TS/Tauri 混合项目，非常适合 | 建议 P0 吸纳 | 作为跨层变更 gate：Tauri command、shared types、DB、前端 API wrapper 联动检查 |
| `finish-work` | 提交前质量门禁，覆盖 lint、typecheck、tests、spec 同步、API/DB、手测 | 直接提升 VibeX 的交付可靠性 | 建议 P0 吸纳 | 做成“提交前 Checklist”：未通过时阻止或强提示 commit/push |
| `record-session` | 完成后记录会话总结、commit hash、后续上下文到 `.trellis/workspace` | 解决跨会话遗忘 | 建议 P1 吸纳 | 任务完成时自动生成 session recap，可写入项目知识库 |
| `break-loop` | bug 修复后分析根因、失败修复、预防机制、扩展排查和知识沉淀 | 对减少重复 bug 很有价值 | 建议 P1 吸纳 | bugfix 任务完成后生成“根因复盘卡”，可追加到项目规则 |
| `update-spec` | 将实现、调试、设计决策、跨层契约写回规范 | 建立项目长期记忆 | 建议 P1 吸纳 | 做成“写回项目知识”入口，让用户确认后更新 docs/AGENTS/knowledge store |
| `improve-ut` | 根据变更文件和测试规范补齐单元测试 | 让 Agent 不止改代码，也补测试 | 建议 P1 吸纳 | 在任务检查后提供“补测试”动作，按变更文件定位测试缺口 |
| `integrate-skill` | 把外部 skill 融入项目规范、示例、模板和索引 | 适合 VibeX 做 skills 生态 | 建议 P1/P2 吸纳 | 支持导入外部 skill，并转成 VibeX 项目模板或 Agent 指令 |
| `create-command` | 脚手架新 workflow skill | 对高级用户有价值 | 建议 P2 吸纳 | 在 Skills 面板提供“创建项目 skill”向导 |
| `onboard` | 交互式介绍 Trellis 工作流、结构和自定义方式 | 团队协作时有价值 | 建议 P2 吸纳 | 做成项目 onboarding 页面，解释本项目工作流、命令和质量门禁 |

## 可吸纳但不应照搬的内容

### 不建议照搬 Gemini/Custom Provider 扩张

用户明确希望 VibeX 只使用 Claude Code、OpenCode、Codex。cc-gui 的多 Provider 叙事虽然显得能力宽，但也会稀释产品焦点。VibeX 应把三类 Agent 的支持做深：

- Claude Code：本地配置读取、模型选项、权限、thinking 过滤、slash command、settings 管理。
- OpenCode：Provider/MCP/Session/Mode 的可视化配置。
- Codex：模型、reasoning effort、sandbox、审批策略、AGENTS.md/skills 工作流。

### 不建议强制 Trellis 式重流程

cc-gui 的 Trellis 很完整，但对小任务可能偏重。VibeX 应采用渐进式工作流：

- 小任务：自动生成简短需求卡，直接执行。
- 中任务：展示上下文包和验证建议。
- 大任务：启用 PRD、阶段、质量门禁和复盘写回。

### 不建议只做静态文档面板

cc-gui 的价值在于 skills 会真的驱动行为，而不是只展示文档。VibeX 如果做 Project Knowledge，必须连接到：

- 新建任务时的 prompt/context 注入。
- Agent 会话前的自动检查。
- 任务结束后的验证和复盘。
- 下次任务的自动召回。

## 如果我是 cc-gui 用户，我希望 VibeX 做出的改进

### 必须改进才会切换

1. **项目知识库可视化**
   - 我需要看到 VibeX 会给 Agent 注入什么规则。
   - 我需要知道这些规则来自哪里，是否过期，是否适用于当前任务。

2. **任务 PRD/验收标准**
   - 复杂任务需要有目标、范围、验收标准和排除项。
   - 多 Agent 并行时，所有执行都应围绕同一任务契约。

3. **执行前上下文包**
   - VibeX 应在启动 Claude Code/OpenCode/Codex 前自动整理相关文件、规则、历史、MCP 和 skills。
   - 用户应能编辑这份上下文包。

4. **任务级质量门禁**
   - 任务结束前给出明确检查项，而不是只让用户看终端输出。
   - 检查项应和变更文件类型相关。

5. **会话复盘与知识写回**
   - 我希望每次完成任务后都能得到可保存的复盘，而不是下次重新解释同类坑。

### 会显著提升吸引力的改进

1. **Prompt Library**
   - 保存常用需求澄清、重构、review、bugfix、测试补齐 prompt。
   - 按 Agent 和任务类型分类。

2. **统一搜索/命令面板**
   - 搜索项目、任务、会话、文件、skills、MCP、docs、历史复盘。

3. **Skills 导入和本地化**
   - 允许导入 cc-gui/Trellis 风格 skills。
   - 导入后转换成 VibeX 任务模板和执行前检查项。

4. **更强的预览上下文**
   - 点击页面元素后，不仅展示组件信息，还能一键生成“修复这个 UI 问题”的 Agent 上下文。

5. **并行任务汇总视图**
   - 多个 Agent/worktree 同时执行后，自动汇总改动、风险、测试结果和冲突。

### 可以延后的能力

- Whisper 语音输入。
- Computer Use。
- 自动更新。
- 完整 i18n。
- 性能报表和复杂 runtime contract dashboard。

这些能力有产品价值，但不应优先于 VibeX 的核心闭环：任务、上下文、Agent 执行、验证、Git、复盘。

## 建议路线图

### P0：补齐工程闭环

- 新增 Project Knowledge 面板：聚合 AGENTS.md、docs、workspace notes、skills、MCP、历史任务复盘。
- 新增任务“执行前上下文包”：自动收集相关规则、文件、历史、点击元素、MCP、skills。
- 新增任务级 Quality Gate：按变更类型推荐并记录检查命令。
- 新增复杂任务 PRD/验收标准区域：支持自动生成和用户编辑。
- 新增提交前 Checklist：和 Git/Diff/Push 流程结合。

### P1：沉淀长期记忆

- 新增 session recap：任务结束时自动总结目标、改动、验证、风险、commit hash。
- 新增 bugfix 复盘卡：根因、失败方案、预防规则、相关文件。
- 新增知识写回：用户确认后写入项目知识库。
- 新增 Prompt Library：按 Agent、任务类型、项目作用域管理 prompt。
- 新增 cross-layer gate：Tauri command、shared types、DB、frontend API wrapper 变更联动提醒。

### P2：扩展高级工作流

- Skills 导入/创建/本地化向导。
- 项目 onboarding 页面。
- 全局搜索和命令面板。
- 并行执行结果汇总。
- 预览点击元素到 Agent prompt 的一键工作流。

### P3：成熟桌面体验

- Whisper dictation。
- Computer Use。
- 自动更新。
- i18n 完善。
- 性能和 runtime contract dashboard。

## VibeX 的差异化方向

VibeX 不应该成为 cc-gui 的功能复制品。更好的方向是：

> VibeX = 聚焦 Claude Code / OpenCode / Codex 的本地 AI 开发任务工作台，以 worktree 隔离为基础，以任务上下文包为核心，以质量门禁和知识复盘形成长期闭环。

这会比“支持更多 Provider、更多面板”更有竞争力。cc-gui 更像多能力集合型 AI GUI；VibeX 可以成为更专注、更可靠、更适合真实开发交付的 AI Agent 工作台。

## 立即可执行的产品任务

1. 在任务详情页增加“上下文”Tab：
   - 展示 AGENTS.md、README/docs、MCP、skills、workspace notes、历史复盘。
   - 支持勾选后注入下一次 Agent 消息。

2. 在任务详情页增加“验收标准”区：
   - 从用户初始 prompt 自动生成。
   - 支持用户编辑。
   - 支持在 follow-up/review prompt 中引用。

3. 在 Diff/Git 区增加“运行检查”动作：
   - 根据变更文件推荐命令。
   - 保存命令输出和结果。
   - 作为 commit/push 前的状态提示。

4. 在任务完成后增加“生成复盘”动作：
   - 自动从会话、diff、测试输出生成经验卡。
   - 用户确认后写入项目知识库。

5. 扩展现有 skills 能力：
   - 不只列出本地 skills，而是让 skill 可绑定任务类型、可注入上下文、可产生任务阶段产物。

## 最终判断

cc-gui 最值得学习的是工作流抽象，而不是 Provider 数量。VibeX 当前已经具备更适合承载真实 AI 编程交付的底座：worktree、任务、会话、Git、预览、三类 Agent 和 Rust 后端服务层。下一阶段应优先补“项目知识如何进入 Agent、任务如何验证、经验如何写回”的闭环。

只要 VibeX 把 P0 和 P1 做扎实，它对 cc-gui 用户的迁移吸引力会很强：cc-gui 用户能得到熟悉的规范/skills/记忆能力，同时获得 VibeX 更强的任务隔离、并行开发和交付审查体验。
