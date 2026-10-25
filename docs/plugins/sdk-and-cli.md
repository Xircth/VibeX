# Plugin SDK and CLI Contract

## 1. SDK 产品组成

当前公共 SDK 与 Host 一起版本化发布：

| Package                      | 用途                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `@vibex/plugin-sdk`          | v2 宿主内 / 联邦模块插件入口（`defineVibeXPlugin`、`ctx.ui.*`、`ctx.hooks.*`、`ctx.services.*`、`ctx.host.*`） |
| `@vibex/plugin-sdk/worker`   | Worker lifecycle、handler 注册与 Capability Broker client                                  |
| `@vibex/plugin-sdk/app`      | 独立 HTML Surface App bridge（`definePluginApp`）与 surface lifecycle                      |
| `@vibex/plugin-sdk/testing`  | `createPluginTestHarness`、`createWorkerHarness`、`createGenerationHarness`、`createAppHarness` |
| `@vibex/plugin-sdk/protocol` | wire DTO、JSON value、分片重组（`frame.chunk`）与 context 类型                             |
| `@vibex/plugin-cli`          | build、validate、test、linked install、dev 与确定性 pack                                   |

SDK 不导出 Tauri command、Axum route、SQLite schema、Host 文件路径或内部 Rust enum。Full Trust
Worker 仍可直接使用 Node 标准库；Broker client 用于结构化 Host/Runtime/Artifact/App lifecycle API。

## 2. Worker authoring interface

最小 Worker：

```ts
import { definePluginWorker } from '@vibex/plugin-sdk/worker';

export default definePluginWorker((registrar, environment) => {
  registrar.handle('create-document', (input) =>
    environment.host.call('runtime.execute', 'run', input)
  );

  registrar.handle('office-preview', (input) =>
    environment.host.call('artifact.preview', 'open', input)
  );
});
```

### 2.1 Registration 规则

- handler ID 必须对应 manifest 中同 kind declaration；
- setup 阶段只注册 handler，不执行外部副作用；
- setup 完成后 registration set 冻结；
- duplicate、undeclared 或 required handler missing 使 candidate activation 失败；
- handler 的输入/输出同时在 Host 和 Worker 按生成 schema 校验；
- registration 不自动启动 Runtime；旧 generation handle 发布新 generation 后变 stale，继续调用返回稳定错误。

### 2.2 Lifecycle

```ts
export interface PluginLifecycle {
  onStart?(context: StartContext): Promise<void>;
  onActivate?(context: ActivationContext): Promise<void>;
  onDeactivate?(context: DeactivationContext): Promise<void>;
  onDispose?(reason: DisposeReason): Promise<void>;
}
```

每个 callback 都收到 `AbortSignal` 和 deadline。`onDispose` 是资源清理机会，不是 correctness
前置条件；Host 在 deadline 后强制撤销 token、关闭 transport 和终止进程。Plugin 不能依靠
dispose 写入唯一状态，持久状态应在正常操作中事务提交。

### 2.3 Host API clients（`HostCapabilityBroker` 实现状态）

HostCapabilityBroker（`crates/plugins/src/host_capability_broker.rs`）与 SDK 已实现以下能力，供 Worker（`environment.host.call`）与 `protocol: "2.0"` 插件（`ctx.host.*`）直接调用：

| 能力域 (`capability`) | 操作 (`operation`) | 实现状态与行为 |
| --- | --- | --- |
| `storage.kv` | `get` \| `put` \| `set` \| `delete` \| `list` \| `clear` | **SQLite 持久化 KV**：按插件 ID 隔离存储，支持前缀列举与批量清空 |
| `storage.settings` | `get` \| `put` \| `set` | 读写插件根 `config.json` 并按 `config.schema` 校验 |
| `secrets` | `get` \| `put` \| `delete` | **OS Keychain / 加密 Secrets**：按插件 ID 隔离存取敏感凭据 |
| `files` | `read` \| `write` \| `stat` \| `list` | **基于授权根目录的文件操作**：在授权根目录（workspace / plugin_data）内读写、stat 与列举目录，越界或路径逃逸返回 `files_root_denied` |
| `network.fetch` | `fetch` | **支持 HTTP/HTTPS 的网络请求**：支持自定义 method、headers、body 与 timeout |
| `exec` | `run` \| `spawn` \| `kill` \| `status` | **子进程执行与后台进程管理**：支持单次执行（`run`）与长生命周期后台进程/Sidecar 管理（`spawn`、`kill`、`status`） |
| `runtime.execute` / `runtime.lock` | `run` \| `get` | 按 Runtime lock 启动受管依赖进程并查询锁状态 |
| `artifact.preview` | `open` | 为只读预览 provider 签发短期 loopback 预览租约 |
| `conversation.*` | `create` \| `list` \| `read.get` \| `append.enqueueInput` \| `steer` \| `cancel` \| `cancelInput` \| `listInputs` \| `respondPermission` \| `respondQuestion` \| `setMode` \| `setConfigOption` \| `catalog` \| `archive` \| `events.since` | 会话创建、读取、追加输入、在途纠偏与事件流读取（未授权会话返回 `conversation_scope_denied`） |
| `events` | `subscribe` \| `ack` \| `publish` | 插件事件订阅、游标确认与发布 |
| `app.notify.toast` | `toast` \| `notify` | 在宿主界面显示 Toast 通知 |
| `remote.profile` / `provider.presets` / `log.*` / `plugin.self` | `list` \| `save` \| `bind` \| `doctor` 等 | 远程 Host 配置、模型预设管理、结构化日志与插件自检 |

Client method 返回 typed error；unsupported、resource missing、timeout 与 cancellation 不合并成
普通异常文本。SDK 提供 feature detection 只用于兼容降级，不触发授权弹窗。

### 2.4 Settings、storage 与 migrations

- settings schema 来自 manifest，Worker 读取已验证值；
- secret 通过 `secrets.get|put|delete` 存储在 OS Keychain / 加密存储中；
- KV entry 和总空间由 SQLite 持久化并受 Host 配额保护；
- SQLite 只属于当前 Plugin identity；
- migration 是编号、append-only、事务执行的静态资源；
- candidate activation 的 migration 先创建 snapshot，失败时恢复；
- downgrade/rollback 若无法读取新 schema，必须在 package metadata 中明确阻止或提供 down
  migration，不能让旧 Worker 直接打开未知数据库。

## 3. App authoring interface（双协议：`2.0` 与 `1.0`）

`entrypoints.app` 支持两种协议：

### 3.1 `protocol: "2.0"` — 宿主内 / 联邦模块 App（`{ "entry": "app/main.js", "protocol": "2.0" }`）

适用于同树 React UI 槽位、命令、面板、Turn Hook、InternalMessageCapture 与 Cordis 风格 IoC 服务。在 `app/main.js` 中使用 `defineVibeXPlugin((ctx) => ...)`，并统一使用命名空间 API（`ctx.ui.*`、`ctx.hooks.*`、`ctx.services.*`、`ctx.host.*`；顶层扁平方法仅为向后兼容保留）：

```ts
import { defineVibeXPlugin } from '@vibex/plugin-sdk';

export default defineVibeXPlugin((ctx) => {
  ctx.ui.registerCommand({
    id: 'refresh-dashboard',
    title: 'Refresh Dashboard',
    async handler() {
      await ctx.host.storage.kv.set('lastRefreshAt', Date.now());
      await ctx.host.ui.notify({
        title: 'Dashboard',
        message: 'Refreshed!',
        variant: 'info',
      });
    },
  });
});
```

### 3.2 `protocol: "1.0"` — 独立 HTML Surface App（`{ "root": "dist/app", "document": "index.html", "protocol": "1.0" }`）

适用于独立 HTML Surface（如 `plugin.detail.panel` 与 `artifact.editor` 可编辑文件 Tab），使用 `definePluginApp(({ root, bridge, signal }) => ...)` 建立 bridge：

```ts
import { definePluginApp } from '@vibex/plugin-sdk/app';

export default definePluginApp(({ bridge, root, signal }) => {
  const button = document.createElement('button');
  button.textContent = 'Refresh';
  button.addEventListener('click', () => {
    void bridge.invoke('dashboard.refresh', {});
  });
  root.replaceChildren(button);
  bridge.ready();

  const dispose = () => root.replaceChildren();
  signal.addEventListener('abort', dispose, { once: true });
  return dispose;
});
```

`protocol: "1.0"` App interface 提供：

- `bridge.pluginId` 与 `bridge.generation`；
- generation-bound Worker RPC（`bridge.invoke`）与 1-hop Host RPC（`bridge.hostCall`）；
- `bridge.artifact`（在 `artifact.editor` 槽位下读写文本与校验 revision）；
- allowlisted realtime signal subscription；
- `ready()` 握手；
- DOM root 与 abort/dispose。

## 4. Worker ↔ Host protocol

### 4.1 Transport

- 每个 Worker 一个 stdio framed JSON-RPC 2.0 connection；
- 默认单帧上限 `32 MiB`（可通过 `entrypoints.worker.maxFrameMiB` 配置 `1..128 MiB`），逻辑消息上限 `64 MiB`；超出单帧上限的消息自动通过 `frame.chunk` 分片传输与重组。自造的分片格式会被拒绝，且不会因此卸载 Worker；
- 视频等更大的二进制走 `blob.*`（单文件 4 GiB，每次 512 KiB），不进 JSON 消息；
- 总并发、日志和二进制 payload 仍有硬限制；
- request 有 ID、deadline、generation、invocation context；
- cancellation 使用显式 notification；
- Worker stderr 只进入 scoped diagnostic log，不作为 protocol；
- secret value 不出现在 trace、error data 或 replayable event。

### 4.2 Handshake

```text
Host → initialize {
  protocolRange,
  hostVersion,
  pluginIdentity,
  packageVersion,
  packageDigest,
  generationId,
  declaredContributions,
  trust: "full",
  features,
  limits
}

Worker → initialized {
  protocolVersion,
  sdkVersion,
  registrations,
  requestedFeatures
}

Host → activate
Worker → ready
```

Host 核对 identity/digest/registrations 后才发布 generation。`trust: "full"` 是 package execution
contract，不是 capability token。

### 4.3 Error envelope

```ts
interface PluginProtocolError {
  code: string;
  message: string;
  retryable: boolean;
  operationId?: string;
  contributionId?: string;
  diagnosticId?: string;
  details?: JsonValue;
}
```

`message` 适合日志而非直接显示秘密/堆栈。Host 根据 stable code 生成本地化用户文案和恢复
动作。未知 error code 映射为通用失败并保留原 code。

## 5. App ↔ Host bridge

App surface 在 mount 时收到一次性 bootstrap：surface token、plugin/generation identity、
protocol range、theme/locale 和允许的方法列表。随后使用 `postMessage`/MessagePort 通信：

- 消息校验 origin、source window、token、sequence 与 schema；
- App 不能选择目标 plugin/generation；
- unmount、navigation away、disable、generation switch 立即撤销 token；
- RPC 由 Host 转发到同 generation Worker；
- realtime 只作失效通知，持久状态通过 RPC/settings 重新读取；
- binary/artifact 使用短期 capability URL。

### 5.1 可编辑文件 Tab

UTF-8 文本格式的插件编辑器声明：

```json
{
  "integrations": [
    {
      "id": "diagram-files",
      "kind": "file.opener",
      "extensions": ["drawio"],
      "editorSurface": "diagram-editor"
    },
    {
      "id": "diagram-editor",
      "kind": "app.surface",
      "slot": "artifact.editor",
      "appEntrypoint": "app",
      "handler": "surface.createSession"
    }
  ]
}
```

App 只使用 SDK bridge：

```ts
const document = await bridge.artifact?.readText();
const saved = await bridge.artifact?.writeText(xml, document.revision);
```

Host 校验 opener/surface/generation 绑定，保管文件路径并执行 revision conflict detection。该 seam
只定义文本读写，不包含任何具体格式的解析、渲染或编辑逻辑。

## 6. CLI

当前 CLI 命令与预期结果（以 `vibex plugin --help` 为准）：

```text
vibex plugin run server [--http://127.0.0.1:17891] [--token <token>]
vibex plugin run dev [dir]
vibex plugin run build [dir]
vibex plugin run test [dir] [--host]
vibex-plugin init [dir] [--publisher id] [--template full|panel|kanban-view|…]
vibex-plugin validate [dir] [--json]
vibex plugin add --dev [dir]
vibex-plugin uninstall [dir] [--delete-data]
vibex plugin pack [dir] [--output file.vxp]
vibex-plugin doctor [dir]
```

普通 `.vxp` 产品安装仍由 VibeX UI 或 `vibex plugin add --profile` 完成。开发期 reload 由 `dev` 的
candidate activation 完成。

### 6.1 `init`

用 `--template full|skill|mcp|hooks|file-tab|editor-tab|host-chrome|panel|kanban-view|…` 选择当前支持的可执行或声明式模板；生成：

- v4 manifest；
- ESM package scripts 与 SDK major dependency；
- Worker/App entrypoint 和自包含 App asset build；
- testing harness；
- Full Trust execution metadata；
- 本地开发脚本。

在 VibeX monorepo 外验证尚未发布的 SDK 时，按 Skill 用 locator 输出替换本地 SDK dependency，
并暂时移除尚未发布的 CLI devDependency；正式发布后使用 manifest `engines.pluginSdk`
对应的 registry 版本。`.vxp` 不收录 package.json、package-manager lock、源码、测试或 source map，
因此不会把本机绝对 SDK 路径写入发布包。

模板不生成 permission 声明；安装或链接插件本身就是 Full Trust 决定。

### 6.2 `validate`

离线完成：

- schema、路径与 identity；
- contribution 引用图；
- handler 与 integration 引用完整性；
- runtime target、版本与 integrity；
- App document/assets 或 `app/main.js` 入口校验；
- SDK/artifact metadata；
- package size、重复文件、symlink escape；
- marketplace policy lint（可选 profile）。

输出机器可读 JSON 和人类摘要。Warning/Failure 有 stable code，开发 Skill 可据此修复。

### 6.3 `dev` / linked install

`dev` 执行增量 build、validate、candidate activation 和 generation reload。每次 reload 都走
生产 lifecycle，不允许直接替换当前 Worker module。Candidate 失败保留旧 generation，并
在 CLI 显示 diagnostic ID。

Linked installation：

- 明确标记开发模式；
- 每个 candidate 都保持同一 Full Trust 模型；
- 每次 build 形成新 digest/generation；
- Host 不删除用户 source directory；
- symlink 和 package root escape 规则与 snapshot 一致；
- App reload 仍经过 generation lifecycle 与 `EffectScope` 清理。

### 6.4 `build` / `pack`

Build：

- bundling 固定 target 与 artifact format；
- SDK runtime imports 标为 Host-provided；
- 禁止不受支持 native dependency；
- 生成 source map，但生产包默认不暴露源码路径；
- 输出 worker/app metadata 与 canonical manifest；
- 相同输入产生相同 bytes。

`test` 会先 build，再由 CLI 把插件测试与当前 SDK 打包到临时目录，并交给 Node test runner
执行。非 Worker 插件测试直接读取真实的 `.vibex-plugin/plugin.json` 校验，无需改成静态 fixture 导出。

Pack 验证完整 package、写 lock/SBOM/signature input 并生成 `.vxp`。Install 从不运行包内
build script。

### 6.5 `doctor`

检查 installed snapshot/digest、Full Trust execution、Worker compatibility、Runtime locks/probes、
Agent bindings、App surfaces 和最近 crash。修复动作必须明确：重建 projection、重新 probe、
rollback 或 reinstall。

## 7. Testing package

### 7.1 In-Host Plugin & Worker harness

```ts
import { createPluginTestHarness, createWorkerHarness } from '@vibex/plugin-sdk/testing';

const harness = createPluginTestHarness({ pluginId: 'acme.my-plugin' });
await harness.activate(myPlugin);
await harness.dispose();

const plugin = await createWorkerHarness(worker, { host: fakeHost });
const result = await plugin.invoke('office-preview', input);
```

Harness 支持：

- UI 槽位、命令、Hook、IoC 服务注册与 `dispose()` 零残留验证；
- declared/undeclared handler matching；
- Host API success/error/unsupported；
- virtual filesystem 与 Artifact identity；
- fake Runtime/process/readiness；
- clock、deadline、abort、crash 与 restart；
- candidate activation、generation switch、drain、rollback；
- storage migration/snapshot；
- log/secret redaction assertions。

### 7.2 App harness

在真实 iframe/message bridge 语义下验证：

- surface bootstrap 与 token revoke；
- theme/locale/reduced motion；
- RPC schema 和 Worker generation routing；
- error boundary；
- 外部资源加载与 network failure；
- accessibility、keyboard 与 focus handoff；
- unsupported client capability。

### 7.3 Package contract tests

SDK 提供 assertions：

- 所有 manifest required contributions 有 handler 或 declarative implementation；
- 使用的结构化 Host API 已由目标 Host feature negotiation 支持；
- Node filesystem/process/network Full Trust 行为符合插件预期；
- Runtime argv 满足 declared operation schema；
- reload/dispose 后无 open handles；
- package build 可复现。

Fake Host 的 fidelity limits 必须列出。跨平台 process lifecycle、CEF/WebView 和真实 Agent
projection 仍需要 VibeX integration suite，不能由 fake green 代替。

## 8. VibeX 插件开发指南 Skill 的契约

随 Host 发布的 Skill 是开发路径的一部分，不是营销文档。它必须：

1. 先定位当前 Host 提供的 SDK types、v4 schema、CLI 与 Host API catalog；
2. 读取目标仓库和适用平台，不猜 SDK 最新版本；
3. 从用户想要的 contribution 与 Runtime/Host API 需求反推包结构；
4. 使用 `vibex plugin init/validate/test/build`，不手写生成 metadata；
5. 为插件编写 contract tests（直接读取真实 `.vibex-plugin/plugin.json` 并覆盖 UI/Worker/App 路径）；
6. 通过 `add --dev` 和 candidate reload 验证真实 Host；
7. 明确记录插件使用的 shell、native、filesystem/network 等 Full Trust 行为；
8. 在完成前运行 `doctor` 与可复现 pack；
9. 产出 installation、usage、data retention 与 troubleshooting 文档；
10. 遇到未知 contribution/Host API 时停止猜测并读取本机 schema。

Skill 自身示例必须由 CI 使用当前 SDK 编译和执行，防止指南与实现漂移。

## 9. SDK 治理

- 稳定接口使用 semver；experimental interface 以 `experimental_`/`experimental.*` 明示；
- 每个 SDK release 发布 changelog、迁移器与 supported Host range；
- Host 至少保留当前和上一 major 的兼容测试窗口；
- deprecated interface 在移除前由 CLI/SDK 编译 warning，并给出自动迁移或明确替代；
- reference plugins 全部从公共 SDK 构建，不允许 import Host internal packages；
- protocol schema compatibility tests 阻止字段重命名、closed enum 扩展和错误码漂移；
- Host feature negotiation 优先于版本猜测。

## 10. SDK 完成定义

满足以下证据之前不得宣称“全套 SDK 可用”：

- 新目录从 `init` 到 `pack` 的 clean-room journey 在 CI 通过；
- Agent-only、App-only、declarative-only 与 full-stack 四种 fixture 均可安装；
- malformed/path-escape/tampered fixtures 被 package contract tests 拒绝；
- Office reference plugin 仅使用公共 SDK；
- SDK Skill 可由 Agent 在空仓库创建并验证一个非 Office 插件；
- linked reload 的失败、crash、Runtime change 与 rollback 有 E2E 证据；
- macOS/Windows/Linux 所支持 target 的 Worker/Runtime lifecycle 验收通过；
- Desktop/Web 的 surface capability negotiation 通过；
- published schema、types、CLI help 和 docs 版本一致。
