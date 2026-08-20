# Conversation、委派与 Workflow 使用指南

本指南描述 VibeX 的持久会话控制面和声明式 Workflow。架构约束分别见
[ADR-0044](../adr/0044-conversation-control-plane-and-durable-inputs.md) 与
[ADR-0045](../adr/0045-workflows-orchestrate-conversation-turns.md)。

## 1. 先理解三个不同动作

- **提交输入**：创建持久 `Conversation input`。会话忙时进入服务端队列，空闲时被认领并
  创建新 Turn；重启、换窗口或 CLI 重试不会把同一个 operation 变成两条输入。
- **纠偏**：只作用于指定的 active Turn，必须携带 `expectedTurnId`。Agent 未协商支持时
  明确失败，不会静默改成下一条输入。
- **委派**：创建独立 child Conversation，并写入 relation。父子只共享导航、策略和结果
  摘要，不共享历史。

所有写命令都应显式复用一个 UUID `operation-id` 进行网络重试。相同 operation 与相同
payload 返回原结果；相同 operation 配不同 payload 会冲突失败。

## 2. CLI 控制会话

CLI 连接已经运行的 VibeX Host：

```sh
export VIBEX_URL=http://127.0.0.1:17891
export VIBEX_TOKEN='replace-with-host-token'

npx vibex conversation create \
  --workspace 00000000-0000-0000-0000-000000000001 \
  --agent codex \
  --title 'Review'

npx vibex conversation send \
  --conversation 00000000-0000-0000-0000-000000000002 \
  --workspace 00000000-0000-0000-0000-000000000001 \
  --agent codex \
  --text 'Review the current diff' \
  --operation-id 00000000-0000-0000-0000-000000000003

npx vibex conversation wait \
  --conversation 00000000-0000-0000-0000-000000000002 \
  --timeout 600
```

常用动作：

| 命令                                                    | 作用                            |
| ------------------------------------------------------- | ------------------------------- |
| `conversation child --parent … --agent …`               | 创建可见 child Conversation     |
| `conversation child … --hidden`                         | 创建只在专用 UI 暴露的 child    |
| `conversation steer --conversation … --turn … --text …` | 纠偏指定 active Turn            |
| `conversation relations --conversation …`               | 查看 direct children 和状态摘要 |
| `conversation output --conversation …`                  | 查看当前输出/Turn 摘要          |
| `conversation cancel --conversation …`                  | 取消 active Turn                |

`wait` 是只读轮询；超时不会取消 Agent。取消必须显式调用 `cancel`。

## 3. 父 Agent 的 scoped MCP 控制

当运行时注入 `session-control` capability 时，companion MCP 暴露：

- `send_session_input(conversation_id, operation_id, text)`；
- `cancel_session_turn(conversation_id, reason?)`；
- `wait_for_session(conversation_id, after_sequence?, wait_ms?)`。

token 只能访问 token 所属父 Conversation 自身及其后代，并且必须处于同一 workspace。
兄弟、祖先、无关系 Conversation 和跨 workspace ID 均按不存在处理。`operation_id` 必须由
调用方生成并在重试时保持不变；`after_sequence` 用于断线后等待新事件。单次长轮询最长
60 秒，客户端可携带返回的 `lastSequence` 再次等待。

## 4. 编写 Workflow Definition

Workflow 是版本化 JSON DAG。Sequence 与 parallel 都由 `dependsOn` 表达，不需要组合器
节点。v1 只执行 `agent` 与 `approval` 两种 Step。

```json
{
  "formatVersion": 1,
  "name": "Parallel review",
  "inputSchema": {
    "type": "object",
    "properties": { "goal": { "type": "string" } },
    "required": ["goal"]
  },
  "steps": [
    {
      "id": "review",
      "dependsOn": [],
      "phase": "inspect",
      "inputBindings": {
        "goal": { "source": "run_input", "pointer": "/goal" }
      },
      "kind": "agent",
      "agentId": "codex",
      "prompt": "Review the repository against the resolved input.",
      "outputSchema": {
        "type": "object",
        "properties": { "summary": { "type": "string" } },
        "required": ["summary"]
      },
      "workspaceAccess": "read_only_shared",
      "sideEffectClass": "read_only",
      "allowOneRepair": true,
      "allowSkipOnReview": false
    },
    {
      "id": "approve",
      "dependsOn": ["review"],
      "inputBindings": {
        "review": {
          "source": "step_output",
          "step_id": "review",
          "pointer": "/summary"
        }
      },
      "kind": "approval",
      "title": "Accept the review?",
      "decisionSchema": {
        "type": "object",
        "properties": { "approved": { "type": "boolean" } },
        "required": ["approved"]
      },
      "approverScope": "workflow.write",
      "skippable": false
    }
  ],
  "policy": {
    "maxConcurrentAgentSteps": 2,
    "maxAgentCalls": 3,
    "deadlineSeconds": 3600,
    "maxOutputBytes": 65536
  }
}
```

绑定中的 `pointer` 是 JSON Pointer。`step_output` 只能读取传递依赖中的已接受结构化输出。
Definition 会拒绝环、坏依赖、越级输出引用、未知 schema 关键字和不一致的只读声明。

## 5. 校验、发布和运行

```sh
npx vibex workflow validate --file workflow.json
npx vibex workflow publish \
  --file workflow.json \
  --operation-id 00000000-0000-0000-0000-000000000010

npx vibex workflow run \
  --version 00000000-0000-0000-0000-000000000011 \
  --workspace 00000000-0000-0000-0000-000000000001 \
  --input input.json \
  --operation-id 00000000-0000-0000-0000-000000000012

npx vibex workflow show --run 00000000-0000-0000-0000-000000000013
npx vibex workflow wait --run 00000000-0000-0000-0000-000000000013 --timeout 1800
npx vibex workflow history --run 00000000-0000-0000-0000-000000000013
```

发布产生不可变版本。修改 JSON 后必须再次发布；已开始 Run 永远继续使用原 version、input
与 policy snapshot。Automation 的 Workflow target 同样固定 version，不追随最新版。

## 6. Workspace 与并发策略

| `workspaceAccess`  | 当前执行语义                                                            |
| ------------------ | ----------------------------------------------------------------------- |
| `read_only_shared` | 保守串行。当前跨 Agent 工具层无法证明通用只读强制，因此不虚假开放并行。 |
| `write_serialized` | 对共享 workspace 获取写串行权。                                         |
| `write_isolated`   | 每个 Step attempt 创建独立 VibeX worktree，可与其他隔离 Step 并行。     |

隔离 Step 记录 parent workspace、独立 workspace/branch、仓库 HEAD checkpoint、resolved
input、定义摘要和终态文件变化。VibeX 不自动 merge、push、publish 或 deploy；用户从
Inspector 打开 child Conversation 和 workspace 后审查结果。

## 7. 结构化输出与 repair

Agent 自由文本仍属于 Conversation 历史。只有通过该 Step `outputSchema` 的 JSON 才成为
accepted output，并可供下游绑定使用。若 `allowOneRepair` 为 true，首次不合法只会创建
一次 repair Turn；repair 也消耗 Agent call budget。再次不合法或输出超过
`maxOutputBytes` 时 Step 明确失败。

## 8. 崩溃、复核与恢复

Host 重启不会重发已发送的 Turn：

- preflight claim 尚未提交给 Agent：可安全回到 ready；
- running Agent Step/Turn：记录 Interrupted；未知写副作用进入 `needs_review`；
- permission/question：只在 Run/Step 投影 `waitingInteraction`，请求和回答仍只存在于 child
  Conversation；无共享写冲突的其他 ready Step 可继续调度；
- waiting Approval：继续等待原决定；
- completed Step：只有 definition、resolved input、runtime、tool set、workspace 与 checkpoint
  证据明确可用且一致时才自动复用；任何未知或不一致都进入 `needs_review`。

Inspector 提供 retry、accept evidence、条件允许时 skip，以及 cancel。CLI 对应：

```sh
npx vibex workflow resume --run RUN_ID --decision retry --step STEP_ID
npx vibex workflow resume --run RUN_ID --decision accept --step STEP_ID --output output.json
npx vibex workflow resume --run RUN_ID --decision skip --step STEP_ID
npx vibex workflow resume --run RUN_ID --decision cancel --reason 'unsafe to continue'
```

Retry 创建新 attempt，旧 attempt、child Conversation 和 evidence 不被覆盖。Accept evidence
在 Step 有 output schema 时必须提供可校验 JSON。

## 9. 保留、清理与故障处理

terminal Workflow Run 默认在 30 天后进入清理候选；running、waiting 和 needs_review 永不
参与。删除 isolated workspace 失败时保留 Run 和证据，等待下次清理重试。清理会软删除
hidden child Conversation 和 relation，再删除 Workflow Run 投影/事件；不会自动删除用户
仓库分支或外部产物。

排查顺序：

1. `workflow show` 查看 Run、Steps 与 events；
2. 在 Inspector 打开对应 child Conversation，查看 Turn 终态、权限与文件变化；
3. 检查 `executionEvidenceJson` 中的 capability、workspace 和 checkpoint；
4. 只有能解释副作用时才 retry 或 accept；不确定时 cancel 并保留证据。

## 10. 明确的安全边界

- companion token 不继承任意 Conversation ID 的访问权；
- `read_only` 文本声明不等于权限强制，无法证明时按潜在写操作处理；
- mutating Step 中断后不自动 retry；
- Workflow 不执行 definition 中的 JavaScript、shell 或远程 `$ref`；
- 无自动 merge/push/deploy；
- token/cost 只有运行时提供可信 usage 时才可报告，calls、deadline、并发和输出字节始终是
  硬限制。

## 11. 发布验证

日常测试不调用真实 Agent，也不依赖本机登录。发布候选除常规 `cargo test`、`pnpm test`、
`pnpm run check` 与 `pnpm run lint` 外，显式运行容量和真实 Agent gate：

```sh
cargo test -p conversations \
  rebuilds_ten_thousand_input_events_with_one_thousand_queued_inputs \
  -- --ignored --nocapture
cargo test -p workflows -- --ignored --nocapture

VIBEX_REAL_AGENT_ACP=/absolute/path/to/codex-acp \
VIBEX_REAL_CODEX=/absolute/path/to/codex \
VIBEX_REAL_AGENT_TIMEOUT_SECONDS=120 \
cargo test -p server --test real_agent_workflow -- --ignored --nocapture
```

真实 Agent gate 必须同时证明：正常 Run 通过真实 Conversation/Turn 完成；运行中 Turn 后
重建 Host 时不自动重发，原 Step 进入 `needs_review`，attempt 与 child 数量保持不变。
设备撤销 gate 使用真实 TCP/WebSocket 连接，验证后续 HTTP 与既有 socket 同时失效。
生产发布仍需在目标发行设备重复容量采样，并执行 OS 级 SIGKILL、跨设备网络抖动和 canary
rollback；本机通过不等于生产环境已经毕业。
