---
status: accepted
date: 2026-08-26
decision-makers:
  - VibeX maintainers
---

# Composer 以 `@` 承载引用面板，`&` 在新会话即可用

## Context

Composer 同时用 `@`、`/`、`$`、`#`、`!`、`&` 六种触发符。用户要记住每种字符对应一类对象，后续每加一种引用就要再占一个字符。Codeg 已经验证了一条更轻的路径：`@` 打开带 Tab 的引用面板（文件、会话、提交等），斜杠命令与技能仍走 `/`、`$`。

多智能体协同插件启用后还有两处产品缺口：

1. 配置页把每个已启用 Agent 的会话控件全部展开。Agent 一多就无法扫读。
2. 新建 Conversation 后输入 `&` 没有候选项，手打 `&Codex` 也不会变成 Mention Token。根因不是插件包缺配置，而是 Host Composer 把 `&` 绑在「当前 binding 已经投递过 `vibex-delegation-mcp`」上。新 Conversation 在第一次 `session/new` 之前没有 binding，因此永远看不到 `&`。ADR-0057 要挡住的是插件启用前就已存在的旧会话，不是启用后新建的会话。

## Decision

### 1. 触发符职责

| 触发符 | 职责 |
|---|---|
| `@` | 引用面板。Tab：文件、会话、提交、指令 |
| `/` | 斜杠命令（Plugin Command 与 Agent Command） |
| `$` | 技能 / 变量 |
| `&` | Agent Mention（委派建议，不变） |
| `#` | 不再作为独立触发符。原指令/标签进入 `@` 的「指令」Tab |
| `!` | 保留兼容触发符，不进入 `@` 面板 |

`&` 继续只表示「请父 LLM 考虑委派」，序列化为 `[&Name](vibex://agent/<id>)`。不把 Agent 放进 `@` 面板。ADR-0031 否决用 `@` 做 Agent Mention 的决定仍然有效。

### 2. `@` 引用面板

输入 `@` 后弹出与 Composer 同宽的面板。Tab 顺序固定：

1. **文件** — 现有工作区/仓库文件引用
2. **会话** — 可点名的 Conversation，参考 Codeg
3. **提交** — 当前仓库 git log
4. **指令** — 原 `#` 标签/内置指令

每个 Tab 独立检索、独立计数、至多 50 条；空 Tab 仍显示。Tab / Shift+Tab 切换 Tab，Enter 选中当前行。无仓库时文件与提交为空，会话与指令仍可用。

序列化沿用「结构化 token，发送为 markdown」：

| 种类 | 写入 Composer 的值 | Agent 看到的意义 |
|---|---|---|
| 文件 | `[@:name](relative/path)` | 现有文件引用 |
| 会话 | `[title](vibex://conversation/<uuid>)` | 会话增强 `get_session_info` 已认识的 URI |
| 提交 | `[shortSha](vibex://commit/<repoId>@<sha>)` | 提交身份；正文带短 SHA 与说明 |
| 指令 | `[#:name]([[tag:...]])` | 现有标签附录展开 |

会话 URI 使用已有的 `vibex://conversation/<uuid>`，不另造 `vibex://session/`。已保存的 `[#:…]` 与 `#` 草稿继续解析，不要求用户改历史。

### 3. `&` 出现条件（修订 ADR-0057 第 7 节）

协同插件启用后：

- **没有 Agent binding**（新建 Conversation，尚未第一次 `session/new`）→ 显示 `&`。下一次 session new/resume/rebind 会按当前启用状态投递。
- **已有 binding 且 `delegation_mcp_delivered`** → 显示 `&`。
- **已有 binding 但未投递**（插件启用前就在跑的会话）→ 不显示 `&`，直到用户 rebind。
- 插件关闭 → `&` 立即消失。

手打且唯一命中已启用、已就绪 Agent 的 `&Name` / `&agent_kind`，与从列表选中一样，保存为 Mention Token。忙于其他操作的就绪 Agent 仍可被提及。

### 4. 子智能体配置列表

`agentDefaults` 仍是插件 `config.json` 的字段，Host 继续用通用 schema 渲染器编辑，不按插件 ID 特判页面。渲染改为默认折叠的列表：一行一个 Agent，点击后才探测并展开该 Agent 的 session mode / config options。配置事实、作用范围（只影响之后委派拉起的子会话）不变。

不把这块改成插件 App surface：折叠列表不需要新的 Host 能力，现有 schema 渲染器已经是配置真相源的编辑面。

## Consequences

- ADR-0039 中「`@` 只引用文件、`#` 引用标签」被本决定取代；`/`、`$`、`&` 的触发职责不变。
- ADR-0057 第 7 节「必须等本次 Conversation 完成投递才出现 `&`」对**尚未建立 binding 的新会话**不再成立；对启用前已存在的会话仍然成立。
- Composer 必须能解析会话/提交 markdown 链接，并在时间线用户消息中显示为 token。
- `conversation_list_recent` 成为 Composer 会话 Tab 的检索入口之一，需从桌面 `application_call` 白名单暴露。

## Considered options

- **把 Agent 也放进 `@` 面板，去掉 `&`。** 否决。与 ADR-0031 冲突，且会把委派建议和普通引用混在同一字符下。
- **`#` 继续作为独立触发符，同时在 `@` 里再放一份指令。** 否决。这正是要消除的双入口。
- **用插件 App surface 重做协同配置页。** 延期。折叠列表可由现有 `agentDefaults` 渲染器完成；为折叠而新增 Worker/App 会把配置编辑权从 `config.json` 表单迁走，没有新能力。
- **在插件包里修补 `&`。** 不可行。`&` 的出现条件和 Token 解析属于 Host Composer 与 Conversation binding，不是插件配置。
