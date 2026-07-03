# 会话领域独立成 crates/conversations

会话编排（turn 生命周期、启动恢复协调器）此前以 1389 行的 `conversation_service.rs` 形式住在 Tauri 二进制里，而投影折叠住在 `crates/db`（造成 db→agents 反向依赖）。我们决定新建 `crates/conversations`（依赖 agents + db）作为事件溯源会话核心的家：turn 编排、恢复协调器、以及从 db 迁入的投影折叠/快照模块都归于此；db 退回哑存储层，src-tauri 只剩薄命令委派。

## Considered Options

- 并入 crates/agents —— 被否决：agents 需新增对 db 的依赖，而投影搬完前 db 又依赖 agents，形成循环依赖死锁迁移顺序；且 agents 已有 manager/runtime 两个 2000+ 行编排层。
- 并入 crates/services —— 被否决：services 已是 27 模块的大杂烩，把核心领域塞进垃圾抽屉是向错误方向加码。

## Consequences

- 投影模块的搬迁与"双投影消灭"（下发协议改为行 upsert + 文本追加操作）分为两个独立改动：先原地改协议，后搬家——避免行为变化与位置变化混在同一个 diff 里。
