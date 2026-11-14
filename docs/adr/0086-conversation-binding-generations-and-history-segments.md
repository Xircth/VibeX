---
status: accepted
date: 2026-11-13
---

# Conversation 绑定代次与历史片段

Conversation 需要在保留用户历史的同时区分 Agent 原生会话与临时连接。仅按最新绑定或当前 Agent 查找历史，会在 rebind 和后续跨 Agent 接续时丢失来源，甚至恢复已放弃的上下文。

Conversation 显式选择 active binding。原生身份属于绑定代次，同一代次不能被另一个 native ID 覆盖。release 只释放连接并保留恢复资格；rebind 失效当前代次，保留原生 ID 作为证据，后续创建冷启动代次。Turn 和运行事件记录 binding 归属，迟到连接不能修改新的代次。

SQLite 只保存 Conversation 历史片段的清单、顺序、来源与完整性证据；内容仍以文件为权威，延续 ADR-0082。发布清单后，打开、翻页、session_info、搜索索引、导出、fork 和 truncate 都读取清单，不再根据当前 Agent 猜测历史文件。建立新绑定前严格接管旧历史；读取、flush 或覆盖校验失败时保留旧文件并报告错误。切换写入目标前退休旧连接路由，flush、sync 并封存旧片段，记录长度与 SHA-256；退休连接的迟到输出不能回落到原生路径。

新快照先完整写入并 sync，再发布数据库清单。已发布快照不可原地改写。封存和新片段发布之间的失败可能留下可读的已封存历史、尚无 active 片段，或未被清单引用的文件；重试可以继续准备，不发布不完整文件。物理孤立文件清理不在本阶段实施。封存快照使用版本化的完整 MessageTurn 条目，保留所有内容块和元数据；实时片段继续使用 ACP wire entry。fork 和 truncate 创建独立快照；历史切点属于其它绑定时，不把其原生消息 ID 交给当前 Agent 执行 native fork。Bundle v1 增加可选 transcript_turns，旧 bundle 保持可读。

本次只实施阶段 A：绑定与历史基础。运行时只恢复明确选中的同 Agent 绑定；保存的旧 native ID 本身不构成跨 Agent 恢复授权。continuation key、portable handoff、交付 attempt 与切换 UI 留给后续阶段。JSONL 条目 ID 带片段命名空间以避免来源冲突；改写历史会推进 history revision，本阶段不承诺跨 fork、truncate 等历史改写保留相同的 durable block ID。实时写入继续遵循 ADR-0082 的 best-effort 行为，严格持久边界用于接管、封存和快照发布。
