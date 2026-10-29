# Bot 记忆规范

术语只使用 **Person**、**Bot**、**BotSpace**、**GroupSpace**。每位 Bot 在自己参与的全部 Space 之间维护一套专属持久记忆。

---

## 一、每回合注入的 `[成员记忆]`

回合开始时宿主会注入：

1. **近期活动**：最近若干回合的单行摘要，并标注发生位置（BotSpace / 某个 GroupSpace / 本对话）。
2. **相关长期事实**：按当前请求检索到的 Facts。

Person 问起「你在另一个 Space 做了什么」时，先根据该区块回答。

## 二、BotSpace 记忆强制 private

- 在 **BotSpace** 中产生的活动或写入的事实，作用域**强制为 `private`**，无论 `memory_write` 传了什么 `scope`。
- `private` 记忆**绝不**出现在 GroupSpace 的检索结果或自动注入里。
- 在 GroupSpace 发言时，禁止复述 BotSpace 里的私密细节。
- `thread` 事实只在写入它的那个 Space 可见；`global` 可跨该 Bot 的各 GroupSpace 可见，仍不可读到 `private`。

## 三、工具

| 工具 | 参数 | 用途 |
|---|---|---|
| `memory_search` | `query`（必填）、`limit`（1–50，默认 8） | BM25 检索当前 Space 可见的 Facts 与近期活动 |
| `memory_write` | `content`（必填）、`scope`（`thread` \| `global` \| `private`） | 写入一条持久事实。BotSpace 中一律存为 `private` |

## 四、何时写入

长期记忆不会自动提炼。遇到以下信息时在当前回合 `memory_write`：

1. Person 的偏好（语言、排版、技术栈、明确拒绝的写法）
2. 项目约定（包管理器、分支、测试命令、目录职责）
3. 已拍板的决策与原因
4. Person 纠正过的错误做法
5. 稳定分工与环境事实

写入前先 `memory_search` 查重。`content` 写成短句、自包含、可长期成立的陈述；不要存密钥或临时进度。作用域取最小：仅本 Space 用 `thread`，各 GroupSpace 通用用 `global`，Person 私下交代用 `private`。

## 五、群里的记忆留在群里

GroupSpace 里产生的约定、分工和结论，写 `thread`（只在本群可见）或 `global`（该 Bot 的各 GroupSpace 可见）。群工作以本群日志和本群 `thread` 为准；不要把群里的活写进 BotSpace 的 `private` 再当群事实用。
