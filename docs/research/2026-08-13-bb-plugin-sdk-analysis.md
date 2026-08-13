# bb Plugin / SDK 架构调研

> 调研日期：2026-08-13
> 上游快照：[`get-bb/bb@84824015e6165bd4b998f480f19fd02c0b9b42ce`](https://github.com/get-bb/bb/tree/84824015e6165bd4b998f480f19fd02c0b9b42ce)，提交时间 2026-08-12。
> 稳定发布参照：[`desktop-v0.37.0`](https://github.com/get-bb/bb/releases/tag/desktop-v0.37.0)，对应提交 `fe432e3b1475406bc0e6f21decefc29ef978e639`。
> 资料口径：只使用 get-bb/bb 仓库的源码、内置作者文档、示例、测试与发布说明。所有源码链接固定到上述 commit，避免 `main` 漂移。

## 结论摘要

bb 的 Plugin 已经是一个真正的**产品扩展包**，不是只给 Agent 消费的工具包。一个
`package.json` 可以同时声明必需的 Server entry、可选 App entry、Skills 和 Themes；
Server factory 再以代码注册 Agent tool、CLI、HTTP/RPC、后台服务、定时任务、设置、
存储、事件和 host-rendered UI，App entry 则注册面板、文件打开器、消息动作、Composer
扩展和可信 content script。这使同一个插件可以同时改变 Agent 能力和用户可见的 bb
产品体验。[manifest schema](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/domain/src/plugin-manifest.ts#L32-L85)
[backend API root](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/backend-contract.ts#L664-L714)
[frontend slots](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/app-contract.ts#L746-L850)

它的核心技术选择是：

1. **一个包、两个执行入口、一个身份。** `server.ts` 在 Node Server 内执行；`app.tsx`
   编译成普通 ESM，在每个 bb 客户端窗口/浏览器标签页执行。两者以派生自 npm 包名的
   Plugin ID 共享路由、存储、设置和 UI 身份。[ID derivation](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/domain/src/plugin-id.ts#L1-L22)
2. **贡献点主要由代码注册，不由 manifest 穷举。** manifest 只负责包身份、入口、
   branding、兼容范围、Skills 和 Themes；Server/App 载入后通过类型化 builder/API
   注册实际 extension points。这降低 authoring 摩擦，但意味着安装前不能只解析
   manifest 就完整展示行为或权限。[manifest reader](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/manifest.ts#L106-L260)
3. **Server 与 App 之间使用宿主 HTTP RPC + WebSocket signal。** App 的 `useRpc()`
   POST JSON 到插件命名空间路由；Server 按 Standard Schema 验证输入和输出；
   `bb.realtime.publish` 通过共享 WebSocket 推送短暂 signal，持久状态仍由 RPC 重取。
   [client hook](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/app/src/lib/plugin-sdk-hooks.ts#L129-L259)
   [server dispatcher](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/routes/plugins.ts#L604-L669)
4. **全信任而非隔离。** Backend 插件与 bb Server 同进程，Frontend 插件与 bb App
   同源；两边都不是 sandbox。CLI 在安装与更新前明确警告插件可以读取全部本地 bb
   数据，甚至其他插件的 secrets。[install warning](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/cli/src/commands/plugin.ts#L658-L715)
   [content-script trust boundary](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/README.md#L24-L35)
5. **它统一了 App + Agent，但没有声明式外部 Runtime 模型。** manifest 没有
   CLI/Binary/MCP runtime dependency、安装 recipe、probe 或 capability permission；
   npm dependencies 是普通代码依赖。插件当然能用 Node 权限自行启动 OfficeCLI 一类
   程序，但宿主无法仅凭 manifest 安装、锁定、诊断或卸载它。因此 bb 是 VibeX
   “App + Skills + PluginActions + OfficeCLI runtime”目标的重要参考，但不是可以原样
   照搬的完整答案。此项是根据 manifest schema 与全信任执行模型得出的架构推论。

## 1. 包格式与 Manifest

最小插件是一个 TypeScript npm-style package，`package.json` 中包含 `bb` block：

```json
{
  "name": "bb-plugin-hello",
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "bb": ">=0.9",
    "bbPluginSdk": "^0.4.1"
  },
  "bb": {
    "name": "Hello",
    "description": "A friendly example plugin.",
    "branding": { "icon": "Zap" },
    "server": "./server.ts",
    "app": "./app.tsx",
    "skills": ["skills"],
    "themes": []
  }
}
```

authoritative schema 的约束是：

| 字段 | 语义与约束 |
| --- | --- |
| `name`, `version` | 必需；Plugin ID 从 package name 最后一段移除 `bb-plugin-` 后规范化得到，scope 不进入 ID。 |
| `engines.bb` | 可选 bb semver 范围。managed install 不兼容时拒绝；开发版 bb `0.0.0` 跳过此项。 |
| `engines.bbPluginSdk` | 可选 SDK semver 范围；缺失被视为 legacy manifest。 |
| `bb.name`, `bb.description` | 必需的用户可见身份。 |
| `bb.branding` | 必需；至少 named icon / plugin-owned SVG icon / light logo 之一。资源必须在插件根内，且防目录或 symlink escape。 |
| `bb.server` | 必需的 Backend factory entry；安装时验证文件存在。 |
| `bb.app` | 可选 Frontend entry；构建成 `dist/app.js`、`app.css`、meta。 |
| `bb.skills` | 可选 Skills roots；默认 `skills/`，`[]` 表示退出；每个子目录的 `SKILL.md` 作为 plugin skill tier 注入 Agent。 |
| `bb.themes` | 可选 palette；仅已加载插件贡献，ID 会加 `plugin:<plugin-id>:` namespace。 |

来源：[`pluginPackageJsonSchema`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/domain/src/plugin-manifest.ts#L32-L85)、
[`readPluginManifest`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/manifest.ts#L106-L260)、
[内置 authoring quickstart](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/SKILL.md#L16-L138)。

值得注意的取舍：顶层 `package.json` 允许其他 npm 字段，但 `bb` 与 branding 内部是
strict schema；扩展贡献也不是一份声明式 contributions 数组，而是在 factory/setup
执行时注册。对 VibeX 而言，这意味着若希望安装确认页在执行第三方代码前就能准确展示
权限、Runtime 和 UI 接管范围，仍应保留更丰富的静态 manifest。

## 2. Extension Points 全景

### 2.1 Backend / Server

`server.ts` default-export `(bb: BbPluginApi) => void | Promise<void>` factory。当前根 API
包含以下区域：[contract](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/backend-contract.ts#L664-L714)

| 区域 | 贡献/能力 |
| --- | --- |
| `bb.log` | plugin-scoped 日志，同时进入 server log 与每插件 JSONL log。 |
| `bb.settings` | 声明 string/boolean/select/project 设置；secret 存 0600 文件且不下发前端。 |
| `bb.storage` | 256 KiB/entry 的 namespaced KV、每插件 SQLite、append-only migration helper。 |
| `bb.http` | 插件命名空间 HTTP route，支持 `local` / `token` / `none` auth。 |
| `bb.rpc` | Standard Schema contract + typed handlers，宿主验证双向 JSON boundary。 |
| `bb.realtime` | 向所有已连接客户端广播 ephemeral `plugin-signal`。 |
| `bb.background` | 可重启的长驻 service；durable cron schedule。 |
| `bb.cli` | 一个 agent/user-facing 顶层 `bb <command>`；实际在 Server 执行。 |
| `bb.agents` | 注册 native agent tool、按 thread/provider 条件选择 tools/skills/instructions、动态指令贡献。 |
| `bb.ui` | Server-side mention provider，以及阻塞式 `requestInput` 与 App renderer 配对。 |
| `bb.events` | 六个 observe-only thread lifecycle event。 |
| `bb.status` | `needs-configuration` 健康状态。 |
| `bb.server`, `bb.hosts` | Server loopback URL、远程 host shared-port tunnel 控制面。 |
| `bb.sdk` | 完整 bb 产品 SDK：threads/projects/environments/files/terminals/providers/skills 等。 |
| `bb.onDispose` | reload/disable/shutdown 时 LIFO cleanup。 |

`bb.cli` 很关键：Server 注册后，核心 CLI 把未知命令代理给 Server；Agent 通过宿主生成的
`plugin-commands` Skill 发现用法。它不是把任意 CLI 二进制安装到 Agent 机器，也不是在
调用者机器执行。多机情况下，文件访问必须用 `bb.sdk.files` 指向 invoking host，不能用
Server 的 `node:fs` 误读同名路径。[CLI contract and multi-machine rule](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/SKILL.md#L595-L655)

Agent tools 是真正的 provider-native tool registration，不只是 prompt skill：参数在
每次调用时校验，工具名跨插件竞争；`configure()` 可按 provider/project/thread 选择本
插件静态注册的 tools/skills，并在下一次 provider session 构造时生效。
[agent contributions](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/SKILL.md#L657-L753)

### 2.2 Frontend / App

`app.tsx` default-export `definePluginApp((app) => ...)`。稳定或公开的 slots 包括：

- Homepage section、Settings section、Nav panel；
- existing-thread panel action 与 experimental new-thread panel action；
- pending interaction renderer、sidebar footer action；
- file opener、assistant message directive、message action；
- experimental thread header action、可完全替换 thread list 的 exclusive provider；
- Composer actions、plus menu、banners、rich-text paint/effect；
- trusted same-origin content scripts。

完整注册面见 [`PluginAppSlots` / `PluginAppBuilder`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/app-contract.ts#L746-L850)。
其中 `fileOpener` 最接近 VibeX Office 预览问题：插件可为扩展名注册 viewer/editor，用户
可以设置默认 opener；插件禁用或卸载时回退到 built-in preview。
[`PluginFileOpenerRegistration`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/app-contract.ts#L653-L670)

App SDK 还提供宿主能力而非让插件重造产品核心：`ThreadChat`、`Markdown` 和 experimental
`NewThreadComposer` 三个 host-owned components，以及 RPC、realtime、settings、route
context/navigation、Composer 和 Sidebar hooks。其他 UI component 不由 SDK 长期共享；
外部插件从 bb 的 shadcn registry vendor 源码并自行拥有，React、portal Radix、Sonner、
Vaul 和 diff runtime 等 singleton 包由宿主 shim，避免多个 React 或 overlay world。
[host runtime implementation](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/app/src/lib/plugin-sdk-app-impl.tsx#L29-L67)
[build shims](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-build/src/build-plugin-app.ts#L23-L74)

Experimental API 不是普通稳定成员：bb 以 `experimental_` 命名并在
[`docs/api_to_audit.md`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/docs/api_to_audit.md)
逐项记录稳定前必须审计的边界。这是值得复用的 SDK 治理习惯。

## 3. 运行拓扑、Runtime 与 IPC

```text
Plugin package
├─ server.ts / dist/server.js
│  └─ bb Server Node 进程内，由 jiti/import 载入
│     ├─ BbPluginApi registrations
│     ├─ 完整 BbSdk（loopback HTTP client）
│     └─ service / cron / tool / CLI handlers
├─ app.tsx → dist/app.js + app.css
│  └─ 每个 Web/Electron client 的同源页面内 dynamic import
│     ├─ slots / hooks / content scripts
│     └─ HTTP JSON RPC ↔ server；WebSocket signal ← server
└─ skills/*/SKILL.md
   └─ Agent thread 的 plugin skill tier
```

### Backend runtime

Backend 没有独立 worker、subprocess sandbox、V8 isolate 或 WASM boundary。loader 使用
`jiti.import()` 在 Server Node 进程内载入 TS 或预构建 ESM；path/builtin 开发树通过
ESM URL generation 和 CommonJS cache eviction 实现 fresh reload。
[`plugin-runtime.ts`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-runtime.ts#L48-L216)

Factory 默认 30 秒 timebox。reload 先建立完整 candidate registration set；candidate
失败则旧实例继续运行。candidate 成功后，宿主停止旧 services、LIFO dispose、等待
in-flight handlers、关闭 SQLite handle、使旧 API handle stale，最后原子替换 registrations。
[`load/commit path`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-runtime.ts#L1068-L1206)
[`dispose path`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-runtime.ts#L1209-L1252)

`background.service` 只是同进程内的生命周期管理：crash 后指数退避重启，abort 时应退出；
它不是 OS 进程隔离。cron 的 due state 是持久行，但仅在插件 loaded 时执行。
[background contract](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/backend-contract.ts#L212-L240)

### Frontend runtime

App bundle 是 CSP-compatible ESM。客户端先在 `globalThis.__bbPluginRuntime` 安装宿主
React 与 SDK，再从 Server inventory 获取 hash URL，link CSS 并 dynamic-import JS。
SDK major 不兼容时跳过；单插件 import/setup/mount 错误被记录，不阻断其他插件。
[`frontend loader`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/app/src/lib/plugin-frontend.ts#L51-L193)

前端 reload 以 bundle hash 为 generation key：先验证 candidate，然后 abort/dispose 旧
content scripts，再挂载新 scripts，最后发布 slots/CSS；失败时不会留下 candidate 的部分
状态。旧浏览器 ESM module object 无法真正 unload，只会失去引用，这是实现明确接受的
限制。[frontend reconcile](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/app/src/lib/plugin-frontend.ts#L631-L815)

### IPC / transport

- Frontend RPC：`POST /api/v1/plugins/:id/rpc/:method`，strict JSON + Standard Schema input/output；
- 自定义 HTTP：`/api/v1/plugins/:id/http/<path>`；
- Frontend assets：`/api/v1/plugins/:id/assets/app.js|app.css`，content hash immutable cache；
- Realtime：共享 WebSocket 上的 ephemeral `{ pluginId, channel, payload }` signal；
- CLI：核心 `bb` CLI 通过 Server API 代理执行 plugin CLI handler；
- Agent tool：由 Server 注册到 provider runtime，handler 仍在 Server 进程执行。

这不是 Electron main/renderer IPC，也没有 Plugin App 直接调用 Node Backend 的桥；Web 与
Desktop 客户端复用相同 HTTP/WS 边界。

## 4. 权限、信任与隔离

### 已有防线

1. CLI 安装和更新默认要求交互确认，并明确显示 full-trust 风险；`--yes` 可跳过。
2. git/npm materialization 使用 staging；npm 带 `--ignore-scripts`，Git dependency install
   还移除仓库自带 `.npmrc` / Yarn rc，避免 registry/TLS/env interpolation 被源码控制。
   [dependency install](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/managed-plugin-artifacts.ts#L98-L163)
3. npm candidate 对照 registry integrity，安装目录另存 SHA-256 content hash；Git 锁到
   resolved commit 并校验 checkout，但 artifact 行的 `integrity` 为 null。
   [Git materialization](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/managed-plugin-artifacts.ts#L464-L548)
   [npm integrity](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/managed-plugin-artifacts.ts#L667-L727)
4. manifest asset path 防目录和 symlink escape；built-in IDs 不允许第三方 shadow。
5. 插件 HTTP 提供 `local`、per-plugin `token` 和 `none` 三种 inbound auth；RPC 永远用
   local-origin/JSON-only CSRF 防线。[route auth](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/routes/plugins.ts#L118-L169)
6. lifecycle、handler、slot、content-script failure 有 containment；更新失败能恢复宿主
   自有状态快照。

### 没有的防线

- 没有 plugin capability/permission declaration，也没有按 API 区域发放 capability；
- 没有 Backend 进程、filesystem、network、environment 或 CPU/memory sandbox；
- 没有 Frontend iframe/origin isolation；content scripts 能访问同源 DOM 和认证客户端状态；
- 没有签名 publisher/trust chain 或第三方审核 marketplace；
- 没有按版本、来源或代码摘要细分的持久 trust grant；确认是安装/更新操作级；
- npm lifecycle script 禁用只保护**安装阶段**，插件 factory 载入后仍执行全信任代码；
- update rollback 只恢复 bb-owned state，无法撤销 candidate 已对外部系统造成的副作用。
  [rollback boundary](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-activation.ts#L121-L176)

因此 error boundary、timebox、staging 和 rollback 应被理解为**可靠性隔离**，不是安全
隔离。对 VibeX 这类本地 IDE/Agent 宿主，若开放广泛第三方生态，原样采用 bb 的全信任
边界会使 Plugin 等价于安装任意本机应用。

## 5. 开发、构建与测试工作流

作者的一条标准路径是：

```sh
bb plugin new hello --app
cd bb-plugin-hello
bb plugin install .
bb plugin dev
bb plugin types --check
bb plugin build
```

- `new` 生成 package、entries、vendored SDK `.d.ts`、tsconfig；`--app` 还 vendor 基础 UI；
- `types` 从当前 bb 刷新 authoritative declarations，无需 Server；
- `build` 生成 `dist/server.js`、`server.meta.json`、可选 `app.js/app.css/app.meta.json`；
- `dev` watch source，构建 frontend 并 reload；
- `install .` 是 linked path install，不复制或删除作者目录；
- `@bb/plugin-sdk/testing` 与 `/testing/app` 提供 backend fake host 与 frontend harness，
  明确列出与真实宿主不一致的 fidelity boundaries。

来源：[authoring quickstart and exact API workflow](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/SKILL.md#L16-L159)、
[testing package guide](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/README.md#L36-L137)。

构建产物的 meta 包含 `sdkMajor`、`sdkVersion`、`artifactFormatVersion: 1`、
`pluginId`、`pluginVersion` 和 `builtWith.bbVersion/pluginSdkVersion`。
[`createPluginArtifactMeta`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-build/src/plugin-artifact-meta.ts#L1-L22)
Backend 以 esbuild 打成 Node 22 ESM，普通依赖内联，`@bb/plugin-sdk` 与
`better-sqlite3` 由宿主提供，native dependencies 不受支持。
[`buildPluginServer`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-build/src/build-plugin-server.ts#L15-L29)

一个很有价值的“Agent-native developer experience”是：bb 自带
`bb-plugin-authoring` Skill，Agent 能先读本机当前版本的 `.d.ts`，再 scaffold/build/install/
reload，而不是靠在线博客猜 SDK。这使“Agent 自己为宿主写插件”成为产品工作流。

## 6. 安装、分发、更新与卸载

### 来源

| 来源 | 行为 |
| --- | --- |
| `path:` / bare local path | 原地注册，宿主不复制、不安装依赖；Frontend 自动 build。用于开发。 |
| `git:` / bare HTTP(S) repo | resolve branch/tag/commit 到 commit，clone 到 staging，npm install dependencies（scripts/dev/optional 禁用），构建 Server + App 后进入 managed artifact。 |
| `npm:` | npm 安装到 versioned prefix，scripts/optional 禁用；有 App 时必须发布预构建 bundle/meta。 |
| `builtin:` | 随 bb app 打包的本地副本；无网络。auto-installed builtins 与按需 official store plugins 使用同一 runtime。 |

安装接口和 source semantics 见 [`PluginService.install`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-service.ts#L155-L179)。
bb 只有一个 maintained official catalog，用户不能添加第三方 catalog；Git/npm/path 是
direct install。Official 插件与 App 一起发布，没有独立 publish pipeline。
[`official-plugin-release-process.md`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/docs/official-plugin-release-process.md#L1-L33)

安装完成写入 registration 且 `enabled: true`，随后立即 load；不是“安装后默认禁用”。
[`registerInstalled`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-registration.ts#L204-L257)

### 更新

更新是手动的：`bb plugin outdated` 检查 tracking source，`bb plugin update` 应用；local
path、builtin 与 pinned npm/git source 不自动跟踪。resolver 只选择同时满足
`engines.bb` 和 `engines.bbPluginSdk` 的 candidate，并单独报告较新但 incompatible 的
版本。[update resolution](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-updates.ts#L128-L219)

managed update 在切换前创建 Plugin registration/host state snapshot，载入 candidate，并
观察默认 30 秒 stabilization window；进入 error 则回滚旧 registration、settings/KV/db/
schedules 等 bb-owned state，且保留失败记录。崩溃中留下的 rollback-pending snapshot 会
在启动时恢复。[activation transaction](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-activation.ts#L193-L339)

### 卸载

remove 会停止插件、移除 registration、schedules、settings 与 secrets；path source 永不
删除，managed artifact 留给 GC。KV 和 `data.db` 明确保留，以支持 remove/reinstall 后的
数据恢复。[remove semantics](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-service.ts#L1486-L1537)

## 7. 版本兼容策略与当前版本

截至调研 commit：

- `@bb/plugin-sdk` 当前版本是 **0.4.1**；稳定 `desktop-v0.37.0` 也携带 0.4.1；
- SDK 仍是 pre-1.0：兼容新增 bump patch，breaking change bump `0.x` minor；
- `PLUGIN_SDK_MAJOR` 由第一段计算，当前始终是 `0`，所以 artifact 的 major-only gate 在
  pre-1.0 阶段事实上不能区分 0.3 与 0.4；真正兼容性依赖 manifest 的
  `engines.bbPluginSdk` range，以及 rebuildable artifact 的 exact SDK version rebuild；
- host 对 App bundle 的 incompatible major 会跳过而不是抛 TypeError；managed install
  对 engine mismatch fail closed，path install 则允许注册但显示 incompatible；
- experimental members 通过名称和 audit ledger 管理，不承诺稳定。

这些限制在源码注释中有明确说明，而不是推测。
[`plugin-sdk-version.ts`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/domain/src/plugin-sdk-version.ts#L1-L17)

插件系统最初于 2026-07-02 合入，Plugin SDK 0.3 于 2026-07-15 合并，0.35.0 首次宣布
Plugins 默认启用并正式发布；0.37.0 的发布说明继续完善 install、Git URL 和性能。
[`CHANGELOG 0.35.0`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/CHANGELOG.md#L184-L200)
[`CHANGELOG 0.37.0`](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/CHANGELOG.md#L1-L75)

## 8. 代表性插件与示例

| 插件/示例 | 验证的能力组合 |
| --- | --- |
| `plugins/docs` | 文件系统 Markdown 产品：Server + App + Skills；最接近“文件能力不应只是 Agent Skill”。[manifest](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/plugins/docs/package.json) |
| `plugins/github` | GitHub issue/PR 浏览、App UI、把内容送给 Agent。[manifest](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/plugins/github/package.json) |
| `plugins/memory` | App + durable Agent memory + Skills，跨 provider。[manifest](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/plugins/memory/package.json) |
| `plugins/tasks` | 完整产品域插件：SQLite、App、CLI、delegation、mentions、lifecycle、Skills。[directory](https://github.com/get-bb/bb/tree/84824015e6165bd4b998f480f19fd02c0b9b42ce/plugins/tasks) |
| `examples/plugins/agent-enrichment` | 无 App 的 agent tools/skills/settings/mentions 参考。[directory](https://github.com/get-bb/bb/tree/84824015e6165bd4b998f480f19fd02c0b9b42ce/examples/plugins/agent-enrichment) |
| `examples/plugins/composer-customization` | Composer actions/plus menu/banner/rich text 全面参考。[directory](https://github.com/get-bb/bb/tree/84824015e6165bd4b998f480f19fd02c0b9b42ce/examples/plugins/composer-customization) |
| `examples/plugins/content-script` | 同源 content script 的完整 cleanup-safe lifecycle。[directory](https://github.com/get-bb/bb/tree/84824015e6165bd4b998f480f19fd02c0b9b42ce/examples/plugins/content-script) |
| `examples/plugins/cascade` | App 接管/重组 bb thread UI，并复用宿主 NewThreadComposer。[directory](https://github.com/get-bb/bb/tree/84824015e6165bd4b998f480f19fd02c0b9b42ce/examples/plugins/cascade) |
| `examples/plugins/slack-bot` | 无 App、签名 webhook 驱动 Agent thread 的外部集成。[directory](https://github.com/get-bb/bb/tree/84824015e6165bd4b998f480f19fd02c0b9b42ce/examples/plugins/slack-bot) |

bb 本身也用插件验证内核：Automations、Connect、Custom Instructions、Inline Vis、Secrets、
Side Chat 等是 auto-installed builtins；GitHub、Docs、Memory、Tasks 是随 App 打包但由用户
按需安装的 official plugins。[builtin registry](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/builtin-registry.ts#L44-L145)

## 9. 对 VibeX 架构选择最有价值的事实

以下是基于上述源码事实的推论，不能混同为 bb 官方设计承诺：

### 应借鉴

1. **同包统一贡献。** Office Plugin 应拥有 Preview/File opener、Skills、Actions、CLI/
   Runtime adapter，而不是由平台内置 Preview 与 Agent Plugin 各自维护身份和生命周期。
2. **Server/App 双入口 + 静态 manifest。** 运行代码可以注册丰富能力，但 manifest 应
   提前声明可审计的 contribution/permission/runtime 摘要。
3. **宿主能力组件，而非暴露内部 UI kit。** 文件预览框架、ThreadChat、Artifact panel
   这类稳定产品能力适合由宿主提供；普通 Button/Dialog 由插件 vendor，减小 SDK ABI。
4. **Backend/App 的 typed JSON boundary。** Schema-first RPC、严格 JSON、ephemeral
   signal + RPC reconcile 是清晰且容易测试的跨进程/跨 Web 客户端方案。
5. **transactional generation lifecycle。** Candidate-first、原子 commit、stale handle、
   LIFO dispose、in-flight drain 和 frontend generation cleanup 应成为统一 Plugin runtime
   的硬契约。
6. **SDK authoring 与 Agent authoring 同时设计。** `types` 同步、本机作者 Skill、
   scaffold、dev loop、fake host、compat meta、experimental audit ledger 缺一不可。
7. **内置能力吃自己的 SDK。** Office 应迁成普通 built-in Plugin，而不是保留 privileged
   特例；SDK 能否承载 Office 全貌会直接检验 extension points 是否足够深。

### 不应原样复制

1. **不要把所有第三方 Backend 与 App 都设为全信任同进程/同源。** 至少要区分
   declarative/trusted-native/sandboxed-web 等 execution class，并为代码贡献声明权限。
2. **不要只在代码执行后才知道贡献。** VibeX 的 install review、远程 Host 管理和
   runtime trust 需要静态、版本化 contribution graph。
3. **不要遗漏 Runtime requirement。** bb 对普通 npm code dependency 管理很好，但没有
   OfficeCLI 这种用户级工具的版本锁、probe、入口、平台分发、冲突与 ownership 模型；
   这正是 VibeX 现行 Plugin control plane 可以保留并深化的差异化能力。
4. **不要依赖当前 major-only artifact gate。** pre-1.0 要直接协商 SDK semver / API
   capability；稳定后再以 major 作为硬 ABI 边界。
5. **不要把确认当权限系统。** 安装前 full-trust warning 对成熟第三方生态不够，应把
   publisher/source/integrity、requested capabilities、runtime code execution、frontend
   surface takeover 和 update delta 分开审计。

## 一手资料索引

- [Plugin SDK README](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/README.md)
- [Built-in plugin authoring skill](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/SKILL.md)
- [Manifest schema](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/domain/src/plugin-manifest.ts)
- [Backend SDK contract](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/backend-contract.ts)
- [App SDK contract](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/packages/plugin-sdk/src/app-contract.ts)
- [Plugin runtime](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-runtime.ts)
- [Installation artifacts](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/managed-plugin-artifacts.ts)
- [Update resolver/lifecycle](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/server/src/services/plugins/plugin-updates.ts)
- [Frontend loader](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/apps/app/src/lib/plugin-frontend.ts)
- [Official plugin release process](https://github.com/get-bb/bb/blob/84824015e6165bd4b998f480f19fd02c0b9b42ce/docs/official-plugin-release-process.md)
- [Stable release changelog](https://github.com/get-bb/bb/blob/fe432e3b1475406bc0e6f21decefc29ef978e639/CHANGELOG.md)
