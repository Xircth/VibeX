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
4. `conversation_events` 继续保存实时 row-op 与会话控制（mode、config、
   commands、权限）。实时投影器按已持久化的事件序号折叠，因此内容事件
   仍写入这张表。打开和翻页不再把这张表当成历史。表暂不 DROP，以便
   revert 后仍能读到旧数据。

## Consequences

- 屏幕上的历史与实时 row-op 在一次刷新后以 JSONL 为准。未刷出的最后一秒
  仍可能只存在于 row-op，这与 Codeg 的 best-effort writer 相同。
- 没有 vendor 解析器的内置 Agent 走 JSONL，不继续为它们维持第二套历史读路径。
- ADR-0044、ADR-0071、ADR-0075、ADR-0081 里「事件日志是 UI transcript」的
  句子由本 ADR 取代。控制面与计量归属目标不变。
- ADR-0005 的独立副本语义不变。分叉复制 transcript 文件，不复制
  `conversation_events`。子会话打开时读自己的文件。
