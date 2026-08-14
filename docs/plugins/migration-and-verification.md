# Plugin Platform Migration and Verification

> 执行信任与权限相关步骤已由 ADR-0046 取代。当前实现为 Full Trust；本文中 sandbox、grant、
> permission diff 与 Trusted Native 内容仅保留为早期迁移历史，不再是发布门禁。

## 1. 迁移原则

这是源模型替换，不是功能开关叠加：

- 每个阶段都向单一 canonical v4 model 收敛；
- 旧 parser/表可以短期作为只读输入 adapter，但不能继续成为写权威；
- Office 纵向切片先证明 App + Agent + Runtime + permission + generation；
- 新测试通过新的深模块 interface，旧特判测试在替代覆盖成立后删除；
- migration 保存历史解释证据，不保留可重新激活的旧产品路径；
- bundled 与 third-party 走完全相同的 runtime contract。

## 2. 交付工作流

### Phase A：契约与安全骨架

交付：

- ADR-0044、v4 schema、canonical protocol/error catalog；
- package compiler 与 malicious fixtures；
- canonical identity/publisher/digest；
- capability catalog、grant diff 与 trust tier；
- SDK/Host compatibility policy。

退出条件：

- App-only、Agent-only、declarative-only、full-stack manifests 均可编译；
- unknown required contribution/permission fail closed；
- path traversal、symlink escape、duplicate normalized paths、digest mismatch 被拒绝；
- v2/v3 adapter 输出 canonical model，但不会执行 shell 或写 activation。

### Phase B：唯一 Control Plane 与数据库

交付：

- Plugin Kernel 外部 interface；
- canonical package/installation/grant/runtime/generation/operation schema；
- v2/v3/旧 control plane migration；
- durable operation progress 与 audit；
- native Agent plugin projection 与 VibeX Plugin inventory 分离。

数据库迁移策略：

1. 新建 canonical tables，不复用语义冲突的旧列；
2. 在单事务中为每个旧 Plugin 生成 migration evidence；
3. 关联两份 Office manifest/两套 registry，发现冲突时 fail closed；
4. 普通 v3 snapshot 编译为 v4 canonical installation；
5. 旧 shell trust 只保存 evidence，不生成 executable grant；
6. 旧 global runtime row 转为 external runtime observation，不能宣称 managed ownership；
7. 建立 read parity report；
8. 切换 Application Core 写入新表；
9. 经过启动/回滚验证后删除旧 write path；
10. 后续 migration 删除无引用旧 runtime tables，legacy evidence 保留。

退出条件：任何安装、启停、更新、binding、runtime lock 与 audit 都只有一个写权威；重启后
状态由 canonical store 重建，不依赖 Office 或 Tauri 内存。

### Phase C：Contribution Registry 与 generation

交付：

- candidate activation；
- atomic registry publication；
- generation lease/drain/rollback；
- Agent/Automation/Composer 从 Registry 解析；
- per-contribution readiness 与 `active_degraded`。

退出条件：

- candidate 失败不可见；
- update 可在旧调用在途时发布，新旧调用固定 generation；
- Host crash 能识别未完成 operation 并恢复最后完整 generation；
- 消费方不直接读取 manifest 或插件私有 runtime。

### Phase D：Capability Broker、Worker 与 Runtime

交付：

- versioned stdio protocol、handshake、limits、cancellation；
- scoped storage/files/network/secrets/runtime/artifact clients；
- OS process isolation 与 crash containment；
- managed content-addressed Runtime、external probe、refcount/GC；
- Trusted Native 独立授权。

退出条件：

- Worker 无 grant 不能读 workspace、联网、spawn 或访问 secrets；
- 插件间 storage/secrets 隔离；
- Runtime 多版本并存，更新失败/旧 lease 不丢旧版本；-恶意/失控 Worker 被 limits 终止且 Host 继续工作；
- shell/native 改变 digest 会重新授权。

### Phase E：Office 纵向迁移

交付见 [office-reference-plugin.md](office-reference-plugin.md)：单 v4 package、通用 file opener、
Artifact preview provider、OfficeCLI lock、Agent contributions 与 generic RenderDescriptor。

退出条件：Office 删除清单全部满足，全仓产品代码无 Office ID/类型特判；Office package 只
依赖公共 SDK；Desktop/Web/Remote 和目标平台矩阵通过。

### Phase F：App SDK 与开发者工具

交付：

- host-rendered stable surfaces；
- sandbox App origin/CSP/bridge；
- SDK worker/app/testing/protocol/build packages；
- CLI init/dev/validate/test/build/pack/install/doctor；
- VibeX 插件开发指南 Skill；
- 非 Office reference plugin 与 clean-room journey。

退出条件：Agent 使用当前安装 SDK 与开发 Skill，在空目录完成一个非 Office App + Agent
插件，且不修改核心即可 linked install、reload、pack、uninstall。

### Phase G：分发与生态治理

交付：

- deterministic `.vxp`；
- registry artifact、publisher signature、SBOM 和 update candidate；
- compatibility-aware update/rollback；
- Marketplace policy scanner；
- SDK deprecation/migration process。

退出条件：签名失败不能降级继承 publisher grants；capability expansion 被准确 diff；更新
失败保留旧 generation；发布包可复现。

## 3. 功能要求—证据矩阵

| 要求              | 权威证据                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| 完整 SDK          | 发布包内容、generated types/schema、CLI E2E、clean-room plugin journey  |
| 可用开发 Skill    | Skill 文件 + Agent 从空仓库完成 reference task 的录制/测试              |
| Office 全能力迁移 | 单 v4 package、Registry inventory、删除搜索、Office E2E                 |
| App Plugin 可用   | App-only fixture 可安装、激活、渲染、禁用、更新、卸载                   |
| Agent + App 一包  | inventory 中相同 package version/digest，原子 generation switch         |
| Runtime 管理      | 精确 lock、digest/probe、并存、refcount、GC 与 rollback tests           |
| 安全沙箱          | 跨插件 secrets/fs/network/process/CSP 攻击 fixtures                     |
| Remote 一致       | BackendTransport/Remote protocol contract 与 browser E2E                |
| 设置与新模块 IA   | Plugin 模块 journey；Agent native plugin tab journey                    |
| 文档完整          | manifest/SDK/CLI/security/migration/reference/troubleshooting docs 校验 |

“有类型”“有按钮”“单元测试通过”不是上述广泛要求的充分证据。完成审查必须逐项找到
对应 runtime/用户 journey 证据。

## 4. 测试金字塔

### 4.1 Package/compiler tests

- 全字段/最小 manifest；
- 每 contribution kind/version；
- App-only/Agent-only/无代码/full-stack；
- unknown optional/required；-引用缺失、重复 ID、循环依赖；
- path traversal、symlink、case collision、archive bomb；
- manifest/file/runtime digest mismatch；
- Host/SDK/feature/platform incompatibility；
- v2/v3 migration adapter 与 legacy evidence。

### 4.2 Kernel integration tests

- install/activate/deactivate/update/rollback/uninstall；
- candidate failure、registration mismatch、permission deny；
- generation atomic visibility、in-flight lease、drain timeout；
- Host crash at every operation boundary；
- concurrent operation serialization/idempotency；
- operation/audit secret redaction；
- plugin data retention 与 explicit deletion；
- native Agent projection reconciliation。

### 4.3 Worker/security tests

- undeclared Broker method；
- scope escape、absolute path、symlink race；
- domain/redirect/DNS rebinding/loopback network escape；
- process argv/shell injection；
- environment/credential leakage；
- cross-plugin storage/SQLite/secrets access；
- oversized frame/log/output、CPU/memory/process bomb；
- stale generation/token replay；
- crash/restart budget、abort/dispose timeout。

### 4.4 App security/accessibility tests

- unique origin、CSP、sandbox flags；
- Host DOM/storage/token access attempt；
- forged origin/source/token/sequence；
- navigation/download/clipboard mediation；
- generation unmount/token revoke；
- RPC input/output schema；
- keyboard/focus/screen reader/zoom/reduced motion；
- surface failure containment；
- unsupported Desktop/Web capability。

### 4.5 Runtime/Artifact tests

- download staging/digest/probe/atomic switch；
- managed vs external ownership；
- same Runtime multi-version coexistence；
- concurrent install/refcount/GC；
- preview process limit、lease close/TTL/crash；
- SSRF/redirect/path/token expiration；
- file revision conflict；
- remote RenderDescriptor 与 reconnect。

### 4.6 End-to-end journeys

至少自动化：

1. CLI 创建、测试、build、pack、安装 App-only sample；
2. linked full-stack sample reload 成功与失败；
3. permission expansion accept/deny；
4. Office install/enable、Agent action、三类 preview、disable/fallback；
5. Office candidate update 失败/成功/rollback；
6. Worker/Runtime crash recovery；
7. Web/remote 插件详情与 preview；
8. Codex/Claude Code Agent 设置中的 native plugin tab；
9. Plugin uninstall、data/artifact retention、reinstall；
10. malicious package install 被拒绝并产生可理解诊断。

## 5. 对抗性审查清单

审查者必须主动尝试推翻设计，而不是确认 happy path：

### 身份与供应链

- 同 ID 不同 publisher 能否继承 grant/data？必须不能。
- 签名更新失败能否退化为 unsigned 同源？必须不能。
- linked source 改 entrypoint/permission 能否无提示 reload？必须不能。
- archive path/case/symlink 能否覆盖 manifest 或其他插件？必须不能。

### 生命周期

- candidate setup 已产生外部副作用后失败如何处理？Broker 在发布前只允许可回滚/activation-
  scoped 副作用；不可回滚能力不在 setup 阶段开放。
- update 中 Host crash 会不会出现 UI 新、Agent 旧？Registry generation 原子发布，必须不能。
- disable 与 in-flight Turn/preview 是否丢证据？调用固定 generation 并有 drain/终态。
- dispose 不响应会不会卡住 Host？deadline 后强制撤销和终止。

### 权限

- 插件可否借 Runtime/preview 访问未授权文件或网络？Runtime argv 与 endpoint 仍由 Broker
  scope 校验。
- App 可否通过 Worker RPC 请求超出 surface grant 的能力？每次 Broker 调用校验 invocation
  context，不信任 App/Worker 自报。
- 一个插件能否枚举其他插件 secret 名称或文件存在性？错误必须不泄露。

### Runtime

- 同名 CLI 的 PATH 劫持？执行精确 lock 绝对路径。
- 更新是否删除正在运行旧 lease 的版本？引用归零前不得 GC。
- external Runtime 改字节不改版本？重新验证 digest，无法官方验证则 fail closed。
- shell installer 是否伪装成普通 Runtime？Schema 与 trust tier 必须拒绝。

### App 与 Remote

- iframe 能否拿主 token、访问 Host origin 或导航到 file://？必须不能。
- preview proxy 能否代理任意 localhost/metadata endpoint？只接受已登记 lease endpoint。
- Remote client 能否发送本机绝对路径让 Host 打开？只接受 scoped identity/relative path。
- 老客户端遇到新 required surface 会不会静默空白？capability negotiation 明确 incompatible。

### Office 特殊化

- 删除 Office package 后核心还能否编译并运行其他 provider？必须能。
- 新增另一个 DOCX provider 是否需要修改 core switch？必须不需要。
- Office disable 后 Agent action 与 preview 是否同步消失？同一 generation，必须同步。
- core 搜索到 `vibex.office` 是否只在 fixture/migration/docs？产品分派中必须为零。

## 6. 数据迁移验证

每个 migration 在副本数据库运行并输出机器可读 report：

- old row count、canonical installation count；
- identity conflicts；
- manifest parse/compatibility failures；-旧 trust/runtime rows 转换决策；
- Agent/MCP binding projection；
- Office duplicate merge evidence；
- orphan Automation/PluginAction refs；
- retained legacy evidence digests。

迁移必须幂等。中途失败回滚新写入，不删除旧表。只有 parity report 无未解释差异、Host 已
从 canonical schema 成功启动并通过 rollback rehearsal 后，后续 migration 才能删除旧表。

## 7. 文档交付

用户/作者可用性要求至少包含：

- Plugin 模块用户指南；
- Agent-native plugin 设置指南；
- v4 manifest reference 与 JSON Schema；
- SDK Worker/App reference；
- permission 与 security model；
- CLI reference；
- tutorial：declarative、Agent-only、App-only、full-stack；
- Office reference plugin walkthrough；
- testing/debugging/doctor；
- packaging/signing/publishing；
- v2/v3 migration；
- SDK compatibility/deprecation；-数据保留与卸载语义；
- VibeX 插件开发指南 Skill。

Docs 中的代码必须由 CI 编译/validate；CLI `--help`、generated schema 与 docs version 不一致
时发布失败。

## 8. 完成审计

最终审计逐项记录：requirement、authoritative evidence、result、remaining risk。结果只有：

- proved；
- contradicted；
- incomplete；
- missing evidence。

只有所有必需项都是 proved 且没有未关闭的高风险对抗性发现时，Plugin Platform 才完成。
不得以“没有发现问题”、局部单测、manifest 存在或 UI 可点击替代端到端证据。

## 9. 回退策略

开发阶段可以回退到上一 canonical migration/installation/generation，但发布后不保留旧
Office 产品路径作为 feature flag。可恢复资产是：

- database backup/migration evidence；
- previous package snapshot；
- previous Runtime locks；
- previous complete generation；
- plugin data snapshot；
- operation/audit log。

回退不得恢复已撤销 permission、已删除 secret 或已明确清除的 plugin data。发生不可逆
外部副作用时必须报告 partial rollback，而不能将 operation 标记为成功或已完全回滚。
