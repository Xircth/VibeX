---
status: accepted
date: 2026-10-18
decision-makers:
  - VibeX maintainers
---

# UI transcript 以 JSONL / vendor 文件为权威，打开窗口对齐 Codeg

对照基准：`C:\Users\18190\Documents\projects\codeg`，pin
`2e657fac44f19a66bdc7ebda6426b3596101848c`。方案全文见
`docs/plans/2026-10-18-conversation-jsonl-window-protocol.md`。

本 ADR 替换「事件日志是 UI transcript 权威」这一条。它不替换会话控制面、
权限、排队输入或 Turn 终态。

## Decision

1. 打开会话和向上翻页读取的历史，只来自 ACP JSONL
   （`acp-transcripts/<agent>/<session>.jsonl`）或已有的 vendor 会话文件
   （Claude、Codex、Cline、Openclaw）。窗口单位是 MessageTurn。缺省
   `Tail(120)`，向用户回合回对齐，上限 500。`fromIndex` 精确切片，不回对齐。
2. 第一次打开尚无 JSONL 的会话时，把现有事件投影编码成 Codeg 兼容 JSONL，
   再按该文件读回。之后的内容事件在文件已存在时追加到同一文件。
3. 前端不再预取全部历史，也不再按 80 行 / 768KiB 裁掉已加载行。更早一页
   120 回合。用户向下跨过距顶 240px 时加载一页；短列表用「更早的消息」。
   刷新带着已加载窗口的起点；前缀指纹不一致时回到尾部 120 回合。
4. 实时屏幕上的内容增量（助手文本、思考、内容块、计划和工具调用）不写入
   `conversation_events`。它们立刻追加到 JSONL；文件不存在时先写 header。
   进程内投影器发出 row-op，并另记数据库游标，避免内存序号挡住随后落库的
   Turn 终态。流式更新不等待磁盘；prompt 与 turn end 最多等 2 秒。
   `UserTurnCreated`、Turn 终态、权限、排队输入、会话控制（mode、config、
   commands）和 `UsageUpdated` 仍写入这张表。用量看板仍读
   `conversation_usage_snapshots`，本变更不引入 `token_usage_turn`。
   打开和翻页不读这张表。序号缺口改为重新读取文件窗口，不再用
   `events_since` 回补。搜索按 `sessions.name` 包含匹配。Markdown / HTML
   导出读取完整 transcript。表暂不 DROP。`project_open` 仍只服务于自身
   测试，不在打开路径上。

## Consequences

- 屏幕上的历史在一次刷新后以 JSONL 为准。流式的最后一秒仍可能只在内存
  row-op 里，这与 Codeg 的 best-effort writer 相同。插件 `events_since`
  读的是事件日志，因此看不到未落库的内容增量。
- 没有 vendor 解析器的内置 Agent 走 JSONL，不继续为它们维持第二套历史读路径。
- ADR-0044、ADR-0071、ADR-0075、ADR-0081 里「事件日志是 UI transcript」的
  句子由本 ADR 取代。控制面与计量归属目标不变。
- ADR-0005 的独立副本语义不变。分叉复制 transcript 文件，不复制
  `conversation_events`。子会话打开时读自己的文件。
