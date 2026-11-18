# Agent 与协作部署：故障定位、恢复和验收

本指南用于区分 Host 管理授权、Agent 原生配置、模型服务和协作部署故障，
并记录修复后实际恢复了哪些能力。安装、认证和会话可用性的领域契约见
[ADR-0012](../adr/0012-agent-installation-and-authentication-are-separate.md)，
原生配置权威见 [ADR-0022](../adr/0022-agent-native-configuration-is-authoritative.md)，
缺失能力的表达见 [ADR-0058](../adr/0058-session-auxiliary-capability-honesty.md)。

## 先确定失败发生在哪一层

| 层级 | 最小验证 | 不能由此推导的结论 |
| --- | --- | --- |
| Runtime | 实际执行路径、版本、启动或协议握手 | 版本命令成功不代表认证成功 |
| 认证与模型服务 | 用所选端点及其配套凭据完成一个可判分的小问题 | `/models` 或 HTTP 200 不代表有效回答 |
| Agent 工具 | 真实读取预置无敏感 canary，并使用返回内容回答 | 模型自述或发现工具目录不代表执行工具 |
| 搜索与抓取 | 检查实际搜索事件、来源、页面打开或抓取结果 | 写出 URL、`search_tool` 发现工具不代表联网搜索；搜索成功不代表抓取成功 |
| Host 管理 | `list_spaces({})`、`manage_bot({"action":"list_agents"})` | 模型 API 成功不代表管理 MCP 可用 |
| 协作部署 | 实际主管身份，创建结果、真实 ID、回读、成员及任务回执 | 角色草稿、普通 Conversation、模型测试不代表 Bot/群已部署 |

每项记录测试时间、Host/工作区归属、Agent 运行路径与版本、配置来源、请求和响应
模型 ID、结果、耗时与证据类型。第三方渠道的模型标识不是底层权重的独立认证。
状态分为通过、失败、不支持和未测；一个能力通过不替其他层填“成功”。

在授权范围内使用小预算、明确超时的测试。先分开测回答、文件工具和搜索，
再验证组合任务；保留先失败后通过的记录，不以一次成功承诺长期稳定。

## 管理 MCP 返回 `user rejected MCP tool call`

1. 先测试上述两个只读管理调用，记录原始返回与时间，停止无变化的重复批量创建。
2. 将同一请求的 Agent 授权事件、Host 权限事件及界面权限卡关联起来。
   `ResolveElicitation ... decision: Decline` 证明客户端收到了拒绝决定，
   不单独证明是用户点击拒绝。聊天里的业务授权与宿主权限卡的协议回传是两件事。
3. 核实当前 Host、Conversation、Agent binding 和实际存储位置。检查某一个
   数据库无记录，不能直接推导会话丢失或没有主管权限；可能检查了其他宿主或存储。
4. 若协议适配不支持某个请求，保留方法名、协议版本、错误码及回传路径的脱敏证据。
   不能根据一句自由文本决定根因，也不能用关闭全局审批或修改内部数据库绕过拒绝。
5. 读取恢复后再检查实际主管身份。把普通 Bot 命名为“主管”不会赋予主管权限。

当前会话缺少某个管理工具时，核对产品能力和会话上下文，不猜造工具名称。
v0.5.0 的协作空间列表提供 **＋ → 创建群聊 / 创建助手**；
**新建分组**是联系人分类。此入口依据官方 UI 源码及中文文案核实，
不等于在故障机器上已完成 GUI 创建验收。

使用产品支持的会话重连、重绑定或另一引擎进行诊断时，应先说明其会话语义，
并重新运行只读验收；不能宣称重启、换模型或升级必然解决授权问题。
原生引擎与 ACP 的优先关系见
[ADR-0087](../adr/0087-dedicated-agent-engine-first-acp-fallback.md)。

## DeepSeek / OpenCode 认证与渠道恢复

遇到 `provider.auth` / HTTP 401，先定位 OpenCode provider options、认证文件和
环境变量的凭据来源及端点归属。诊断输出仅包含来源名、是否存在、必要的匹配结果，
不能打印凭据值或完整命令参数。不同渠道的密钥不能互相试投。

恢复顺序：

1. 私下备份将修改的原生配置和认证文件，记录回滚路径；备份也含秘密，不作为报障附件。
2. 核对渠道目录及实际可用模型，使用该端点所属的有效凭据先测一个小问题。
   例如 `19+23` 应得到 `42`；返回 `pong` 即使 HTTP 200 也不算通过。
3. 通过后再同步端点、认证和显式模型映射，核对默认模型及轻量任务模型。
   渠道切换是配置恢复，不等于旧供应商已经修好。
4. 新会话先完成回答，再让 Agent 实际读取 canary 并使用文件内容回答。
   不能把直接 API 成功当作 OpenCode 或 Dimo Bot 的完整验收。
5. 保留超时等失败记录，核实后台服务是否已读取新配置；不为一次测试终止用户其他工作。

## Grok 自定义渠道：回答、模型选择与搜索分别验证

Grok 本地 `[model.<table>]` 的表名与发给供应商的 `model` 字段不是同一概念。
`models.default` 和 CLI 选择值需要解析到包含正确端点与凭据的表。
显式选择 API 模型 ID 不应被未经验证地当作自定义表的别名。

仅在该渠道确实支持后端搜索时，按所安装 CLI 的版本文档配置搜索模型与能力声明。
以下是对已有自定义表的字段增补示意，**不是可直接替换整个配置文件的完整配置**：

```toml
[model.dimo]
# 保留现有 model、base_url、认证和 api_backend。
supports_backend_search = true

[models]
# 保留其他已有选项。
web_search = "dimo"
```

修改前需用该渠道做真实搜索验证，不应对所有 OpenAI-compatible 服务默认开启。
CLI 1.0.88 的本机说明 `11-custom-models.md` 将自定义搜索模型与
`supports_backend_search` 分开说明；其他版本应重新核对对应文档。

验证顺序为：自定义表回答 → 文件读取 → 真实搜索 → 显式模型选择 →
隔离配置中重新保存供应商 → 新会话复测。服务端 `web_search_call`、客户端工具事件
和最终引用应相互对应。独立 `web_fetch` 不可用时保持单独状态，不能因搜索通过就标绿。

遇到 503、流式请求重试或托管模型目录告警，分别定位服务、协议和目录来源；
搜索配置缺失不能解释所有延迟。可以为诊断设置有限重试，但减少重试并不修复上游服务。

## 本次会话的修复记录与证据边界

本节是 **2026-11-18** 的案例快照，后续状态以对应 Issue 为准。现场为 Windows、
Dimo 0.5.0、Codex CLI 0.169.1、OpenCode 2.3.0、Claude Code 2.1.327、Grok CLI 1.0.88。
源码复核基线为
[`0fb0dcf`](https://github.com/DimoADE/Dimo/commit/0fb0dcf43666ccad40f2301b2a69777460b44fef)。
原生 CLI / 供应商 API 测试与 Dimo 管理验收分别记录；本文不上传原始日志或配置。

### 问题清单

| 问题 | 已完成的处理 | 快照时的状态 / 后续 |
| --- | --- | --- |
| 管理只读 MCP 持续拒绝 | 复测两项读取并关联客户端 Decline 日志；核对源码请求分支 | 未恢复，见 [#93](https://github.com/DimoADE/Dimo/issues/93) |
| MCP 授权协议适配疑点 | v0.5.0、v0.5.1 和基线源码中未找到显式 elicitation 解析分支 | 缺少实际 RPC 方法名，尚未闭环根因，见 #93 |
| 当前会话与所查本机记录不对应 | 只读检查 binding/permission；发现其他 Master 身份 | Host/存储归属仍待核实，不判定丢数据 |
| 群管理工具缺失及主管身份不明 | 核实 UI 创建入口及“分组”与“群聊”的差别 | 自动化入口/身份需实际确认，见 [#96](https://github.com/DimoADE/Dimo/issues/96) |
| 组织方案未落地 | 保存角色、知识来源、任务和定时协作设计，未伪造身份/群 ID | 26 个 Bot、8 个群及调度尚未部署验收 |
| 初期未找到报障入口 | 查到官方仓库，使用已有 GitHub CLI 登录提交并回读 | 已提交 #93–#96，缺少 MCP 工单工具不是无法报障 |
| DeepSeek 旧渠道 401 / 异常 pong | 备份后改用已有可用渠道的配套凭据及验证过的 4.1 路由 | 本机回答/read 恢复，旧渠道未修复 |
| Grok 超时、搜索未执行 | 修正模型选择，绑定搜索模型及能力，限制诊断重试 | 本机回答/read/搜索恢复；保存风险见 [#94](https://github.com/DimoADE/Dimo/issues/94) |
| Claude WebFetch 安全检查失败 | 原生 CLI 测 Read、WebSearch；沙箱外重测抓取 | Read/搜索通过，抓取未恢复；责任层未确定 |
| Gemini 搜索兼容路径 400 | 分开验证回答、受控函数往返和兼容搜索端点 | API 回答/函数通过；Antigravity Agent 未验收 |
| 新渠道偶发超时 | 保留首次 API 70 秒及 standalone 100 秒超时；随后普通服务复测 | 后续通过不等于长期稳定性证明 |
| Runtime 缓存版本落后 | 对比缓存与现场版本命令 | 观察到不一致，未证明 UI 错误；诊断需求见 [#95](https://github.com/DimoADE/Dimo/issues/95) |
| 更新检查失败 | 记录 updater 的 HTTP 非成功/连接失败，独立查询官方发布 | 可能是瞬态或网络路径差异，未证明更新器代码缺陷 |
| Windows 多行 prompt 包装错误 | 测试由 `.cmd` 改为原生可执行文件后重做 | 测试脚本问题已纠正，不归因 Dimo 驱动 |
| 业务项目旧文档、统计口径、缓存与采集问题 | 只读复核并在业务项目内部登记；更正旧文档导致的误判 | 属于用户项目，未上传业务资料或当作 Dimo 缺陷 |
| 长会话台账陈旧 | 同步“未测试/未提交”等历史状态，建立真实回执索引 | 历史报告保留日期，不能替代最新验收结果 |

### 本机修复前后

| 测试入口 | 修复前 | 实际修改与复测 |
| --- | --- | --- |
| OpenCode / DeepSeek | `provider.auth`、401；直接旧接口曾答 `pong` | 同步 provider 端点、认证及显式 API key 来源，设默认/轻量模型为已验证 4.1。请求 `deepseek-v4-1-flash-261017`，响应 `deepseek-v4.1-flash`；普通后台服务回答 5.41 秒、真实 read 往返 7.62 秒，退出 0 |
| Grok / 自定义渠道 | 180 秒测试超时；`read_file` 成功但未完成真实搜索；日志有 503 和目录重试 | 为默认表绑定后端搜索，补显式 `grok-4.7` 同渠道映射，模型重试上限设 2。显式选择回答/read 13.45 秒；搜索 14.78 秒，均退出 0 |

文件 canary 的金额字段为 `17,26,39`，模型真实读取后算出 `82`，同时正确返回
预置标识；搜索题为 Python 3.14.0 官方发布日期，CLI 产生两次完成的真实搜索并回答
2025-10-07，引用 [Python 官方发布页](https://www.python.org/downloads/release/python-3140/)。
直接 Responses API 另产生 `open_page` 事件，不能据此认定 CLI 独立 `web_fetch` 已可用。

上述测试是单次功能冒烟，不是基准评测、文笔排名或供应商 SLA。
模型渠道恢复后，Dimo 管理 MCP 仍被拒，未据此继续冒称组织部署成功。

### 源码线索与尚缺的回归验证

- [Codex 请求解析](https://github.com/DimoADE/Dimo/blob/0fb0dcf43666ccad40f2301b2a69777460b44fef/crates/agents/src/engine/codex_protocol.rs)
  的 `parse_codex_server_request` 显式处理命令/文件审批和用户问题；
  [读取循环](https://github.com/DimoADE/Dimo/blob/0fb0dcf43666ccad40f2301b2a69777460b44fef/crates/agents/src/engine/codex.rs)
  对不支持的 server request 返回 `-32601`。这只是与现场 Decline 对照的线索，
  仍需实际方法名和请求/响应关联记录确认，不能把猜测作为已修复根因。
- [Grok 供应商保存](https://github.com/DimoADE/Dimo/blob/0fb0dcf43666ccad40f2301b2a69777460b44fef/crates/server/src/host/native/model_providers/grok.rs)
  的 `apply_grok` 调用 `entry.clear()`，仅写回 model、base_url、name、api_key、
  api_backend 和可选 context_window。搜索声明及 max_retries 不在写回字段中。
  代码支持“手动补充字段经此路径会丢失”的判断；未在生产配置点击保存故意触发回退。
  应在隔离配置中回归保存前后行为，结合 ADR-0022 明确字段所有权和保留策略。

### 未归因于 Dimo 的失败

Claude 原生 CLI 的 WebFetch 对 Python 官方域名报 `Unable to verify if domain ...
is safe to fetch`，沙箱外复测相同。Gemini 第三方兼容路径 `/responses` 与
`web_search_preview` 组合返回 HTTP 400 / Not Found，但回答和受控函数往返成功。
这些结果不能证明 Dimo 导致失败，也不能证明对应模型原生能力不存在。
同一 Gemini 请求别名返回不同后缀时，应记录原始响应型号，不静默宣称精确底层版本。

更新器在 2026-11-18T08:17:20Z 报 HTTP 非成功，在 12:00:59Z 报 GitHub 更新 URL
连接失败。独立 GitHub CLI 后来可查询 v0.5.1，并不证明出错时同一 URL 可用，
也不证明代理/网络相同。升级前按发布说明处理数据迁移和备份，不承诺升级解决 #93。

## 回滚与完成条件

配置修复前留原生文件备份；回滚时恢复与该次变更匹配的配置和认证文件，再验证
新会话。恢复旧渠道也会恢复其旧故障。不要在应用保存与手动恢复之间并发修改同一文件。
不要把仍在运行的会话重启当成默认步骤；变更后续新会话和既有会话的语义需分别核实。

完整恢复至少需要：

- 管理只读调用成功，权限卡与回传结果可对应，实际主管身份已确认。
- 一个 Bot 与一个群先完成创建、真实 ID 回读、模型绑定和成员验证，再去重批量部署。
- 任务有真实派发/投递回执；定时协作有实际调度配置，不只是设计文本。
- Grok 在隔离环境保存供应商后仍能真实搜索；不支持搜索的渠道明确显示能力缺失。
- 原生 API、Agent、Bot 和 Host 管理分别验收，未测项保持未测。

## 报障与修复记录的发布

向 [官方 Issues](https://github.com/DimoADE/Dimo/issues) 提交前先去重，
将已知根因、推测、修复动作、实际结果和未完成项分开写。正式提交以服务端编号及回读
为准；本地 Markdown 草稿不算提交完成。

需要时使用 GitHub CLI 的 `--body-file` 保留多行正文。只提交最小脱敏证据，
不上传完整配置、令牌、数据库、原始聊天、模型内部推理或业务材料；
参数数组和环境变量同样可能含秘密，不能只按 JSON 键名脱敏。

本案例的 [#96 总追踪单](https://github.com/DimoADE/Dimo/issues/96) 关联
[#93 管理授权](https://github.com/DimoADE/Dimo/issues/93)、
[#94 Grok 配置](https://github.com/DimoADE/Dimo/issues/94) 和
[#95 分层诊断](https://github.com/DimoADE/Dimo/issues/95)。
本文记录诊断与本机恢复过程，不实施 Host 协议或配置保存逻辑修复，也不作为这些问题
已关闭的依据。
