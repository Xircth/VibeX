# Worker、App 与 Host 调用

公开 SDK：`@vibex/plugin-sdk`（支持 `defineVibeXPlugin` 以及 `/worker`、`/app`、`/testing`、`/protocol`、`/stdio`）。常量 `VIBEX_PLUGIN_API_VERSION` 为 `"2.0"`，`VIBEX_PLUGIN_PROTOCOL_VERSION` 为 `"1.1"`。Python 包 `vibex_plugin`，Rust crate `vibex-plugin-sdk`。

## Node Worker 入口

Host 启动：

```text
node --max-old-space-size=128 <entrypoints.worker.path>
```

工作目录是包根。环境含 `NO_COLOR=1` 与 `VIBEX_PACKAGE_CLASS=full-trust`。该进程必须在 stdin/stdout 上执行协议 1.1：`initialize`（谈成 `1.1`，此时 `registrations` 为空）→ `activate`（回复已注册 handler）→ `invoke` / `ping` / `dispose`。默认单帧上限 `32 MiB`（可通过 `entrypoints.worker.maxFrameMiB` 配置 `1..128 MiB`），逻辑消息上限 `64 MiB`，超出单帧上限的消息自动通过 `frame.chunk` 分片传输与重组；请求缺省超时 30 秒。stderr 只进诊断日志。

推荐拆分（Office 与 Workflow Creator 采用此结构）：

```text
runtime/worker.mjs   # definePluginWorker(...)
runtime/main.mjs     # runStdioPluginWorker(definition)
```

`runtime/worker.mjs`：

```js
import { definePluginWorker } from '@vibex/plugin-sdk/worker';

export default definePluginWorker((registrar, environment) => {
  registrar.handle('hello', async (input) => ({ ok: true, input }));
  registrar.onDispose(() => {
    /* 关句柄 */
  });
});
```

`runtime/main.mjs`：

```js
import { runStdioPluginWorker } from '@vibex/plugin-sdk/stdio';
import definition from './worker.mjs';

await runStdioPluginWorker(definition);
```

清单：

```json
"entrypoints": {
  "worker": {
    "path": "dist/worker.mjs",
    "runtime": "node",
    "protocol": "1.1"
  }
}
```

`vibex-plugin build` 把 `runtime/main.mjs` 打包为 `dist/worker.mjs`。测试从 `runtime/worker.mjs` 导入定义。

setup 阶段只注册 handler，不执行外部副作用。重复 id、非法 id 会使激活失败。

handler id：

```text
^[a-z][A-Za-z0-9]*(?:[.-][a-z][A-Za-z0-9]*)*$
```

TypeScript：定义放 `runtime/worker.ts`；`runtime/main.mjs` 导入该定义并调用 `runStdioPluginWorker`。

## Python / native

Python：`from vibex_plugin import define_plugin_worker, run_stdio_plugin_worker`。`if __name__ == "__main__"` 里启动 stdio。Host 用 CPython 3.12.11。

Rust：`vibex_plugin_sdk::{define_plugin_worker, run_stdio_plugin_worker_blocking}`。清单 path 指向已编译二进制。

## App（双协议）

### 1. `protocol: "2.0"` — 宿主内 / 联邦模块 App（`app/main.js`）

清单声明：

```json
"entrypoints": {
  "app": {
    "entry": "app/main.js",
    "protocol": "2.0"
  }
}
```

使用 `defineVibeXPlugin((ctx) => ...)` 并在激活函数内统一使用命名空间 API（`ctx.ui.*`、`ctx.hooks.*`、`ctx.services.*`、`ctx.host.*`）：

```js
import { defineVibeXPlugin } from '@vibex/plugin-sdk';

export default defineVibeXPlugin((ctx) => {
  ctx.ui.registerCommand({
    id: 'hello-cmd',
    title: 'Run Hello',
    async handler() {
      await ctx.host.storage.kv.set('lastRunAt', Date.now());
      await ctx.host.ui.notify({ title: 'Hello', message: 'Executed!', variant: 'info' });
    },
  });
});
```

### 2. `protocol: "1.0"` — 独立 HTML Surface App（`dist/app/index.html`）

清单声明：

```json
"entrypoints": {
  "app": {
    "root": "dist/app",
    "document": "index.html",
    "protocol": "1.0"
  }
}
```

使用 `definePluginApp(({ root, bridge, signal }) => ...)`：

```js
import { definePluginApp } from '@vibex/plugin-sdk/app';

export default definePluginApp(({ bridge, root, signal }) => {
  const button = document.createElement('button');
  button.textContent = 'Hello';
  button.addEventListener('click', () => void bridge.invoke('hello'));
  root.append(button);
  bridge.ready();
  const dispose = () => button.remove();
  signal.addEventListener('abort', dispose, { once: true });
  return dispose;
});
```

`bridge`：`pluginId`、`generation`、`invoke(handler, input?)`、`hostCall?(capability, operation, input?)`、`subscribe(channel, listener)`（支持 `context`）、`ready()`。`artifact` 仅在 `artifact.editor` 文件页存在：`name`、`readText()` → `{ name, content, revision }`、`writeText(content, expectedRevision)`。

`runtime/app.mjs` + `runtime/app.html` + 可选 `runtime/app.css`。build 产出 `dist/app/index.html`。

结构面 Federation `mount(root, environment)` 带 `workspaceId` 与 `invoke(handler, input)`。`invoke` 打到本插件 Worker。`vibex plugin run dev` 期间 Host `loadRemote` 指向 Vite。

## host.call（HostCapabilityBroker 真实实现状态）

Worker 通过 `environment.host.call(capability, operation, input?)`（以及 `protocol: "2.0"` 宿主内插件通过 `ctx.host.*` 1-hop RPC）调用 `crates/plugins/src/host_capability_broker.rs` 中已实现的 Host 能力：

| 能力域 (`capability`) | 操作 (`operation`) | 实现状态与行为说明 |
| --- | --- | --- |
| `storage.kv` | `get` \| `put` \| `set` \| `delete` \| `list` \| `clear` | **SQLite 持久化 KV**：按插件 ID 隔离存储，支持前缀列举与批量清理（同时维护进程内热缓存） |
| `storage.settings` | `get` \| `put` \| `set` | 读写该插件根 `config.json` 并按 `config.schema` 校验 |
| `secrets` | `get` \| `put` \| `delete` | **OS Keychain / 加密存储**：按插件 ID 隔离管理敏感凭据，不再返回空占位 |
| `files` | `read` \| `write` \| `stat` \| `list` | **基于授权根目录的文件访问**：在授权根目录（workspace / plugin_data）内读写文件、查询元数据与列举目录；仅当越界或路径逃逸时返回 `files_root_denied` |
| `network.fetch` | `fetch` | **支持 HTTP/HTTPS 的网络请求**：由 Host 代理发起 HTTP/HTTPS 请求，支持自定义 method、headers、body 与 timeout |
| `exec` | `run` \| `spawn` \| `kill` \| `status` | **受管进程执行**：一次性命令执行（`run`）与长生命周期后台子进程/Sidecar 管理（`spawn`、`kill`、`status`），插件停用或重载时自动清理残留进程 |
| `runtime.execute` / `runtime.lock` | `run` \| `get` | 按 Runtime lock 启动受管依赖进程；input 需 `runtimeId`，stdin JSON ≤ 1 MiB，超时 120 秒 |
| `artifact.preview` | `open` | 打开预览；需 Host 签发的约 30 秒一次性 `artifactHandle` 及 `providerId`，返回 `leaseId`、loopback `port`、`capabilityToken`、`expiresAtUnixMs` |
| `conversation.*` | `create` \| `list` \| `read.get` \| `append.enqueueInput` \| `steer` \| `cancel` \| `cancelInput` \| `listInputs` \| `respondPermission` \| `respondQuestion` \| `setMode` \| `setConfigOption` \| `catalog` \| `archive` \| `events.since` | 创建、查询、追加输入、在途纠偏与订阅插件拥有或获授权的 VibeX Conversation（未绑定会话返回 `conversation_scope_denied`） |
| `remote.profile` / `remote.connect` | `list` \| `upsert` \| `forget` \| `connect` \| `disconnect` | 管理客户端已保存的远程 Host 列表并切换连接（卸载插件时默认保留已保存 Host） |
| `provider.presets` | `list` \| `save` \| `bind` | 模型供应商预设管理；`bind` 走宿主确认弹窗 |
| `events` | `subscribe` \| `ack` \| `publish` | 插件事件订阅、游标确认与广播发布 |
| `app.notify.toast` | `toast` \| `notify` | 在宿主界面触发 Toast 通知（支持 `info`、`success`、`warning`、`error`） |
| `log.*` / `plugin.self` | `debug` \| `info` \| `warn` \| `error` \| `doctor` | Scoped 诊断日志与插件自身状态查询（返回 `pluginId`、`generation`、诊断与最近崩溃） |

明确受边界保护的拒绝码：

- `files.*` 访问未授权根目录或路径包含 `..` 逃逸 → `files_root_denied`。
- `conversation.*` 访问未绑定的会话 → `conversation_scope_denied`。
- `artifact.readText|writeText` 直接从 Worker 调用 → `artifact_not_found`（文本编辑器 I/O 通过 App `bridge.artifact` 执行）。

## 测试 harness

```js
import { createWorkerHarness, createGenerationHarness } from '@vibex/plugin-sdk/testing';
import definition from '../runtime/worker.mjs';

const worker = await createWorkerHarness(definition);
await worker.invoke('hello', {});
await worker.dispose();

const gen = await createGenerationHarness(definition, {
  requiredHandlers: ['hello'],
});
await gen.activateCandidate(definition);
await gen.dispose();
```

宿主内 App（`protocol: "2.0"`）使用 `createPluginTestHarness` 测试 UI 槽位、命令、Hook 与服务注册。独立 HTML Surface App（`protocol: "1.0"`）使用 `createAppHarness`（需要 jsdom 的 `root`，可传入 `artifact: { name, content, revision }` 覆盖文件页，`revoke()` 模拟 Host 收回 surface）。
