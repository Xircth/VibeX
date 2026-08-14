# bb Parity and Product Readiness

对照基线为 `get-bb/bb@84824015`。这里区分“已形成用户闭环”和“仍是平台路线”，避免用类型定义或
按钮替代真实完成度。

| 维度                           | VibeX 当前状态                                                                    | 相对 bb                                            |
| ------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| 一包扩展 App + Agent + Runtime | README、content、config、Worker/App、integrations、Runtime 同一 digest/generation | 已对齐，并增加内容寻址 Runtime                     |
| 用户入口                       | 单列安装列表、搜索、Loading、添加/开发、独立内容/配置详情                         | 已对齐产品认知；不暴露内核术语                     |
| Agent 原生插件                 | Codex/Claude 页面底部折叠，独立列表/预览                                          | 优于混入产品插件目录                               |
| 生命周期                       | candidate-first、atomic publish、generation drain、rollback、restart recovery     | 已对齐/部分超越                                    |
| Full Trust                     | Worker/App/Runtime 与 Host 同用户权限，无 permission gate                         | 与 bb 的 full-trust 方向一致，交互更简单           |
| 开发体验                       | SDK + CLI init/build/test/dev/link/doctor/pack/uninstall，真实 Host reload        | 已对齐；Runtime 可自动准备到 candidate digest      |
| 内置插件                       | 通用目录发现与内容指纹，无 Office core 分支                                       | 优于单 reference package 特判                      |
| 外部 Runtime                   | target/digest/版本 lock、多版本并存、probe、复用                                  | 超出 bb 当前 manifest/runtime 模型                 |
| App surfaces                   | file opener、preview、plugin detail custom surface                                | 部分对齐                                           |
| Server/Remote                  | 共用 registry、surface 与 enable/runtime 基础路径                                 | 部分对齐；写操作与 Artifact identity 未闭环        |
| 发行/发现                      | builtin、ZIP/snapshot、developer link                                             | 落后：无 Marketplace、git/npm source、签名更新通道 |
| App 插槽广度                   | 尚无 command/toolbar/status/composer/message 等完整公共 Host slots                | 落后 bb                                            |
| 后台服务/RPC                   | Worker invocation 与 surface RPC 已有；通用 service/background contribution 尚无  | 落后 bb                                            |
| 设置/存储/秘密                 | 根 config.json 已闭环；KV/SQLite/secrets namespace 尚未产品化                     | 落后 bb                                            |

## 下一阶段优先级

1. 先补公共 App slots：command、toolbar/status、composer/message；每个 slot 都必须有 package schema、
   Registry descriptor、Desktop/Remote adapter、SDK API、卸载/代次语义和 reference fixture。
2. 建立 Marketplace source adapter：registry index、publisher identity、install/update/rollback UI；Full
   Trust 不要求权限门禁，但仍需要明确来源、版本与完整性证据。
3. 把旧 `PluginAction` 会话/自动化 API 迁移为 Workflow binding，消除两套用户概念。
4. 统一 Rust/TypeScript validator 与 fixture corpus，并完成真实 clean-room SDK 项目 CI。
5. 补齐 Server write commands、Remote Artifact handle 和跨设备 E2E。

当前版本已经是可运行的 Full Trust 产品插件纵向平台，不再是 Office demo；但在 Marketplace、App
slot 广度和通用持久服务三项完成前，不应宣称整体功能面已全面超过 bb。
