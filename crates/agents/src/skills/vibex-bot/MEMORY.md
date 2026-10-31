# Bot 记忆与收藏规范

术语只使用 **Person**、**Bot**、**BotSpace**、**GroupSpace**。每位 Bot 在自己参与的全部 Space 之间维护一套专属持久记忆，并与本 Space 的主题知识库（`topics/<topic>.md`）及共享收藏库（`~/.vibex/spaces/<space_id>/collection/`）联动。

---

## 一、三层知识与存储架构

不同颗粒度的信息必须分流存放，保持核心记忆精炼高信噪比：

| 层级 | 载体与路径 | 容量上限 | 适用内容 | 写入方式 | 读取方式 |
|---|---|---|---|---|---|
| **L1 核心记忆** | `~/.vibex/spaces/<space_id>/MEMORY.md`（每个 Space 独立文件、唯一事实源） | 单条 ≤ 300 字；整页 ≤ 4,000 字 | 一句话定论：Person 偏好、项目工程约定、已拍板决策、纠偏规则、稳定职责边界 | `memory_write`（不传 `topic`），或回合后模型自动审查（`add` / `edit` / `remove`） | 每回合自动按相关性注入 `[成员记忆]`；或 `memory_search(query)` |
| **L2 主题知识库** | `~/.vibex/spaces/<space_id>/topics/<topic>.md` | 单篇 ≤ 16,000 字 | 体系化专项笔记：模块架构说明、接口契约汇总、复杂链路排查手册、领域规范 | `memory_write`（传 `topic` 与 `title`） | `[成员记忆]` 的 `## Index` 露出 `[[topic:<slug>]]` 指针；按需调 `memory_search(query: "", topic: "<slug>")` 读全文 |
| **L3 共享收藏库** | `~/.vibex/spaces/<space_id>/collection/` | 不限长度（含二进制） | 工作的初步结论、根因排查报告、完整设计方案、接口契约、代码快照、日志、截图或外部附件（避免长文在聊天框刷屏，供群成员共同查阅与原位修改迭代） | 会话文件读写工具，或 Person 在 UI「收藏到本空间」 | `[成员记忆]` 的 `## Index` 露出已纳入索引的 `[[collection:<file>]]` 指针；按需用文件读取工具打开对应文件并基于此修改完善 |

---

## 二、每回合注入的 `[成员记忆]` 与渐进式深读

回合开始时，宿主会在投递信封前自动注入 `[成员记忆]` 区块，包含三部分：

1. **近期活动**：最近若干回合的单行活动轨迹，标注发生位置（BotSpace / 某个 GroupSpace / 本对话）。
2. **相关长期事实（`MEMORY.md`）**：按当前请求检索到的核心 Facts，格式为 `- [#f12 thread] 事实内容`（其中 `f12` 为 `fact_id`，可直接用于原位更新或删除）。
3. **主题与收藏索引（`## Index`）**：列出当前 Space 可按需调取的知识指针：
   - `- [[topic:<slug>]] — 标题（首行摘要）`
   - `- [[collection:<file>]] — 标题（内容摘要）`

**按需深读与群收藏协同纪律（Progressive Recall & Collection Collaboration）：**
- 看到 `## Index` 中的某个 `[[topic:<slug>]]` 与当前任务相关时，先静默调用 `memory_search(query: "", topic: "<slug>")` 拉取该主题文档全文，再动手执行。
- 看到 `## Index` 中的某个 `[[collection:<file>]]` 或前序成员提到某份群收藏文件与当前任务相关时，先静默用文件读取工具读取 `~/.vibex/spaces/<space_id>/collection/<file>`；若你有新增结论、补充验证或修正，**直接修改更新该收藏文件**，并在聊天消息中用一两句话说明增量结论与已更新的文件名，不要把长篇内容重复发到聊天里。
- Person 问起「你在另一个 Space 做了什么」或过往背景时，先根据 `[成员记忆]` 回答；区块没有的细节再调用 `memory_search(query: "关键词")` 检索，**严禁凭印象编造**。

---

## 三、BotSpace 记忆强制 `private`（隐私隔离铁律）

| 作用域 (`scope`) | 写入场景 | 可见范围与隔离边界 |
|---|---|---|
| `private` | **BotSpace 强制锁定**，或 Person 私下交代的个人事项 | **仅在该 Bot 自己的 BotSpace 可见**。在 BotSpace 中产生的活动或调用 `memory_write` 写入的事实，无论传入什么 `scope`，宿主一律强制存为 `private` |
| `thread` | GroupSpace 内产生的本群约定、分工与结论 | **本群全体成员共享可见、可协同更新/清理**；不会泄漏到其他 GroupSpace |
| `global` | 该 Bot 跨多个 GroupSpace 通用的工程规范或经验 | 在该 Bot 参与的各 GroupSpace 与 BotSpace 均可见，但**绝不包含 `private` 内容** |

- `private` 记忆**绝不**出现在任何 GroupSpace 的 `memory_search` 结果或 `[成员记忆]` 自动注入里。
- 在 GroupSpace 发言时，**严禁复述或暗示** BotSpace 里的私密细节。
- GroupSpace 的工作以本群日志和本群 `thread` 记忆为准；不要把群里的工作结论写进 BotSpace 的 `private` 再当群事实用。

---

## 四、`memory_search` 与 `memory_write` 工具详解

| 工具 | 参数说明 | 典型调用方式 |
|---|---|---|
| `memory_search` | `query`（必填，按 `topic` 读全文时传 `""`）<br>`topic`（可选，指定 `[[topic:<slug>]]` 的 `<slug>`）<br>`limit`（可选，1–50，默认 8） | 1. 关键词检索：`memory_search(query: "数据库迁移约定", limit: 8)`<br>2. 深读主题全文：`memory_search(query: "", topic: "auth-flow")` |
| `memory_write` | `content`（必填，事实陈述或 Markdown 正文；`remove` 时可传 `""`）<br>`scope`（可选：`thread` \| `global` \| `private`）<br>`op`（可选：`add` \| `replace` \| `remove`，默认 `add`）<br>`fact_id`（`replace` / `remove` 核心事实时必填，如 `"f12"` 或 `"#f12"`）<br>`topic`（可选，写入或删除 `topics/<topic>.md` 的 `<slug>`）<br>`title`（可选，主题文档标题） | 1. 新增核心事实：`memory_write(op: "add", scope: "thread", content: "前端状态管理统一使用 Zustand")`<br>2. 原位替换旧事实：`memory_write(op: "replace", fact_id: "f12", scope: "thread", content: "前端状态管理已迁移至 Jotai")`<br>3. 删除作废事实：`memory_write(op: "remove", fact_id: "f12", content: "")`<br>4. 写入/更新主题文档：`memory_write(topic: "api-contract", title: "接口契约规范", content: "# 接口契约\n...")`<br>5. 删除主题文档：`memory_write(op: "remove", topic: "api-contract", content: "")` |

---

## 五、模型驱动记忆审查与主动代谢纪律（DS-Bot 范式）

每个 Space（BotSpace `direct:<bot_id>` 与每个 GroupSpace `<space_id>`）各自拥有独立的 `MEMORY.md`（辅以 `reviewed.json` 游标与 `journal.jsonl` 变更日志），完全基于文件存储，不依赖 SQLite 表。回合结束后，宿主会调用模型对本回合新增对话与当前 Space 的编号记忆条目（`[1]`, `[2]`, …）进行审查，由模型输出 `{"changes": [{"op": "add"|"edit"|"remove", ...}]}` 原位增删改 `MEMORY.md`。

除回合后模型自动审查外，遇到以下高价值持久信息时，**无需等 Person 提醒「记住这个」**，可在当前回合主动调用 `memory_write`：

1. **Person 的偏好**：语言、沟通风格、排版习惯、技术栈倾向、明确拒绝的写法。
2. **项目约定**：包管理器、分支策略、测试与构建命令、目录职责边界。
3. **已拍板的决策与原因**：架构选型、接口取舍、业务规则定论。
4. **Person 纠正过的错误做法**：被指出过的踩坑点，写入记忆防止重犯。
5. **稳定分工与环境事实**：各 Bot 的固定职责边界、本地/测试环境关键配置说明（不含密钥）。

**维护与安全准则：**
- **原位代谢而非堆砌**：写入前先看 `[成员记忆]` 或 `memory_search` 查重。若已有旧条目过时或发生变更，**必须**使用 `op: "replace"` + `fact_id` 原位更新，或用 `op: "remove"` 移除，禁止只追加新条目导致新旧事实冲突。
- **自包含短句**：核心 Fact 的 `content` 写成短句、自包含、可长期成立的客观陈述；不要写「刚刚」「今天」等相对时间，不要存临时任务进度或日常寒暄。
- **严禁写入密钥与凭证**：密码、API Key（如 `sk-...`、`ghp_...`、`AKIA...`）、Token、私钥块、身份证/银行卡号等严禁写入记忆或主题文档。宿主安全守卫会自动拦截并报错；若被拦截请勿变相重试。
- **完成校验**：作用域取最小（仅本群用 `thread`，跨群通用用 `global`，私下交代用 `private`）。`memory_write` 返回成功才算已记住。

