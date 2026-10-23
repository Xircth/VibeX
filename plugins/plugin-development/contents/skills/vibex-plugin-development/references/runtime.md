# Worker、App 与 Host 调用

公开 SDK：`@vibex/plugin-sdk`。常量 `VIBEX_PLUGIN_API_VERSION` 为 `"1.0"`，`VIBEX_PLUGIN_PROTOCOL_VERSION` 为 `"1.1"`。Python 包 `vibex_plugin`，Rust crate `vibex-plugin-sdk`。

## Node Worker 入口

Host 启动：

```text
node --max-old-space-size=128 <entrypoints.worker.path>
```

工作目录是包根。环境含 `NO_COLOR=1` 与 `VIBEX_PACKAGE_CLASS=full-trust`。该进程必须在 stdin/stdout 上执行协议 1.1：`initialize`（谈成 `1.1`，此时 `registrations` 为空）→ `activate`（回复已注册 handler）→ `invoke` / `ping` / `dispose`。单帧 1 MiB，请求缺省超时 30 秒。stderr 只进诊断日志。

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

## App

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

`bridge`：`pluginId`、`generation`、`invoke(handler, input?)`、`subscribe(channel, listener)`（当前 CLI 打包的 App 只支持 `context`）、`ready()`。`artifact` 仅在 `artifact.editor` 文件页存在：`name`、`readText()` → `{ name, content, revision }`、`writeText(content, expectedRevision)`。

`runtime/app.mjs` + `runtime/app.html` + 可选 `runtime/app.css`。build 产出 `dist/app/index.html`。App 协议 1.0。App 通过 `bridge` 访问文件与 Worker。

结构面 Federation `mount(root, environment)` 带 `workspaceId` 与 `invoke(handler, input)`。`invoke` 打到本插件 Worker。`vibex plugin run dev` 期间 Host `loadRemote` 指向 Vite。

## host.call

Worker 通过 `environment.host.call(capability, operation, input?)` 调 Host。按 `crates/plugins/src/host_capability_broker.rs` 的现实现：

已经能当功能用：

- `runtime.execute`：按 Runtime lock 启动进程。input 需 `runtimeId`。stdin JSON ≤ 1 MiB，超时 120 秒。
- `artifact.preview` / `open`：打开预览。需要 Host 签发的约 30 秒一次性 `artifactHandle`，以及 `providerId`。成功返回 `leaseId`、loopback `port`、`capabilityToken`、`expiresAtUnixMs`。
- `storage.kv.get|put|delete|list`：按插件 ID 隔离的进程内 KV。
- `storage.settings.get|put`：读写该插件 `config.json`。
- `conversation.create` `{ agentId, workspaceId?, title?, prompt? }`：创建并绑定一条 VibeX Conversation。省略 `workspaceId` 则使用插件自己的 scratch 工作区。
- `conversation.list`：只列本插件拥有或被授予的会话。
- `conversation.read.get` `{ conversationId }`：摘要 + 最近 Turn + 排队输入 + sequence。
- `conversation.append.enqueueInput` `{ conversationId, text, images?, modeOverride? }`：同一条 `submit` 控制面。
- `conversation.steer` `{ conversationId, expectedTurnId, text }`：在途纠偏。
- `conversation.cancel` / `conversation.cancelInput` / `conversation.listInputs`
- `conversation.respondPermission` / `conversation.respondQuestion`
- `conversation.setMode` / `conversation.setConfigOption`
- `conversation.catalog`：可选 Agent。
- `conversation.archive`
- `conversation.events.since` `{ conversationId, afterSequence? }`：时间线行。
- `remote.profile.list|upsert|forget`：客户端已保存 Host。`provisionKind` 是来源标记。
- `remote.connect` / `disconnect`：把应用壳接到已保存 Host。
- `provider.presets.list|save|bind`：供应商预设；`bind` 走宿主确认。
- `log.*`：scoped 诊断，返回 `{}`。
- `plugin.self` / `doctor`：返回 `pluginId`、`generation`、诊断与最近崩溃。

会明确失败：

- `network.fetch` → `network_denied`。Full Trust 用语言运行时自己联网。
- `files.read|write|stat|list` → `files_root_denied`。
- `conversation.*` 对未绑定会话 → `conversation_scope_denied`。
- `agent.invoke` → `handler_not_visible`。
- `artifact.readText|writeText` → `artifact_not_found`。文本 I/O 在 App bridge。

占位：`secrets.*` 回 `{ "present": false }`。`events.subscribe` 回 `{ "cursor": 0 }`。`app.notify.toast` 回 `{}`。其余 `capability_unimplemented`。

卸载插件时保留已保存 Host，省略 `remote.profile.forget`。

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

`createAppHarness` 需要 jsdom 的 `root`。可传入 `artifact: { name, content, revision }` 覆盖文件页。`revoke()` 模拟 Host 收回 surface。
