# get-bb/bb Plugin SDK 一手资料分析

研究日期：2026-08-13。上游源码固定到 commit
[`84824015e6165bd4b998f480f19fd02c0b9b42ce`](https://github.com/get-bb/bb/tree/84824015e6165bd4b998f480f19fd02c0b9b42ce)，
避免随主分支漂移。本文只记录会影响 VibeX Plugin Platform 决策的事实。

## 结论

bb 的 Plugin 不是单纯给 Agent 增加 tools：同一 package 可以装载 Server、App、Skills、theme
与 engine，运行后再向 Host 注册 tool、CLI、RPC、background service、settings、storage、panel、
file opener、message/composer UI 和 content script。因此，“一个用户可安装的产品插件同时扩展
Agent 与 App”是已经被实际代码验证的方向。

VibeX 应借鉴统一 package、前后端 SDK seam、candidate-first reload 与可回滚安装；但不能照搬
其 full-trust 进程模型。VibeX 还必须把 Runtime requirement、内容寻址安装、权限与 invocation
scope 纳入内核，这正是 OfficeCLI 一类完整产品插件所需而 bb manifest 当前没有表达的部分。

## 一手源码事实

### Manifest 是身份与入口声明，不是完整能力清单

bb manifest 静态声明 identity、server/app/skills/themes/engines：
[plugin-manifest.ts](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/domain/src/plugin-manifest.ts#L32-L85)。
Server/App 的具体 contributions 由代码载入后动态注册，所以仅凭 manifest 无法在安装前完整审计
能力上界。VibeX v4 选择静态 contribution 与 permission 上界，再要求 Worker registration 是其
子集；这使 permission review、兼容判断与恶意包拒绝可以发生在执行代码之前。

### Backend 与 App 都是正式 SDK surface

Backend root contract 包含 tools、CLI、RPC、background、settings 与 storage：
[backend-contract.ts](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/backend-contract.ts#L664-L714)。
Frontend contract 包含 panels、file opener、message/composer 与 content script slots：
[app-contract.ts](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/app-contract.ts#L746-L850)。
App↔Server privileged request 使用 JSON/schema RPC；realtime signal 走共享 WebSocket。这个边界让
Desktop 与 Web 可以复用插件语义，VibeX 也因此把 App Surface Host 放进共享 Application Core，
而不是只做 Tauri command。

### Reload 具有 generation 语义

bb 的 runtime 会先加载候选、完成注册后提交，再 abort/dispose 旧 service；它处理 LIFO dispose、
in-flight drain 与 stale handle：
[plugin-runtime.ts](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-runtime.ts#L1068-L1252)。
这是 VibeX candidate → active → draining → retired 模型的直接参考。VibeX 进一步把 generation、
contribution、grant 与 Runtime lock 持久化，使 Host restart 后仍能恢复同一发布事实。

### 安装来源与回滚值得借鉴

bb 支持 path/git/npm/builtin；npm install 禁用 scripts并校验 registry integrity，Git 固定 commit/
content hash，更新是 compatibility-aware manual operation，并有稳定观察期与 restart-safe rollback。
这些机制说明安装来源必须先物化为可验证 candidate，不能把 mutable directory 或 registry tag
直接当成发布代。VibeX 的 snapshot/link、deterministic package digest 和 candidate reload 沿用这
一原则。

### 上游当前是 full-trust

Backend 通过 jiti 在 bb Node Server 同进程执行，Frontend ESM 在每个客户端同源执行；没有
worker/process/iframe sandbox。CLI 因而在安装时明确警告插件拥有完全信任：
[plugin.ts](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/cli/src/commands/plugin.ts#L658-L715)。
VibeX 面向可扩展 Office/File/Runtime 场景，不能让第三方默认获得 Server 用户权限或 App origin，
所以采用独立 Worker、Capability Broker、opaque iframe、CSP 与 digest-scoped grants。

### SDK 版本门禁不能只看 major

该固定点的 SDK 为 0.4.1；pre-1.0 时 major 恒为 0，只做 major gate 几乎没有保护。bb 同时使用
`engines.bbPluginSdk` semver 和 exact-sdk rebuild 缓解：
[plugin-sdk-version.ts](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/domain/src/plugin-sdk-version.ts#L1-L17)。
VibeX v4 因此同时校验 Host engine、SDK semver、wire protocol major 与 contribution kindVersion，
不靠单一版本号猜 feature。

## 借鉴与差异化

| 问题            | bb 可借鉴点                       | VibeX 决策                                               |
| --------------- | --------------------------------- | -------------------------------------------------------- |
| 产品边界        | Server + App + Skills 同包        | App + Agent + Host + Runtime 同 identity/digest          |
| App/Server seam | schema JSON RPC + shared realtime | Application Core contract，Desktop/Remote 薄 adapter     |
| Reload          | candidate-first、dispose、drain   | 持久 generation、lease drain、restart recovery           |
| 安装            | integrity、commit pin、rollback   | deterministic snapshot/link digest、候选回滚             |
| 权限            | full-trust 明示警告               | 默认 sandbox，publisher/id/digest/capability/scope grant |
| App 代码        | 同源 ESM                          | opaque-origin iframe + CSP + MessagePort                 |
| Runtime         | manifest 未建模外部工具 ownership | `id+version+target+digest` lock、probe、Broker execution |

最终结论不是“复制 bb API”，而是采纳其产品插件统一性与生命周期成熟度，同时把安装前静态审计、
隔离、安全授权和 Runtime ownership 设计成 VibeX 的内核能力。Office reference plugin 正好是这个
差异的验收样例：预览、Skills、Actions 与 OfficeCLI 必须作为一个可安装、可授权、可回滚的产品。
