# VibeX 插件开发文档

对照 Host 0.1.3、协议 1.1、SDK 1.0.0 和当前仓库里的 CLI。开发、校验、链接、诊断只走命令行。不要向用户索要 token。

查工具链路径可以在仓库根执行 `vibex-plugin toolchain`（本地 `packages/plugin-cli`）。它会打印 Host 版本、CLI、contract、JS / Python / Rust SDK 路径和模板名。

## 你在开发什么

你在做一个产品包，不是再搭一套应用运行时。框架是已经打开的 VibeX。包有一个身份、一份 README、一份根配置、一份 `contents/`，以及一组写死的 integrations。

最少要有一项 Host 认得出的 integration。不再要求必须带 Skill。

安装或链接这个包，就按 Full Trust 跑。Worker、App 和声明的 Runtime 使用与 Host 相同的本机权限。独立进程和 App frame 管热更新、崩溃和 dispose，不是安全沙箱。只有 `packageClass` 为 `isolated` 的包才走 OS 沙箱。

## 一次初始化

```bash
# 在仓库里
node packages/plugin-cli/dist/cli.js init my-notes --publisher you --template full
```

`init` 会写出清单、README、`config.json`、内容索引、测试和对应模板的源码，并立刻 `build` 一次。默认模板是 `full`。

可用模板

- `skill` 只投影 Skill
- `mcp` 只声明托管 MCP
- `hooks` 只声明 Hook
- `file-tab` Worker 加 `.txt` 只读预览
- `editor-tab` 可编辑 UTF-8 文件 Tab
- `full` Worker、App、Workflow
- `ts-worker` / `node-worker` 只要 Node Worker
- `python-worker` CPython Worker
- `rust-worker` native Worker
- `host-service` 后台定时 handler

不要用 `--template agent`。那个入口已经删了。

`init` 不是 Next 那种整框架脚手架。它只给你一份能挂进 Host 的包。

## 包结构

```text
my-plugin/
├─ .vibex-plugin/
│  ├─ plugin.json
│  ├─ content.index.json
│  ├─ package.lock.json          # build 生成
│  └─ signature.json             # pack 可写
├─ README.md
├─ config.json
├─ contents/
│  ├─ skills/
│  ├─ mcps/
│  ├─ hooks/
│  ├─ workflows/
│  └─ resources/
├─ depends/
│  └─ runtimes/
├─ runtime/                      # 源码，不进发布物
└─ dist/                         # build 输出
```

路径相对包根，用 `/`。拒绝绝对路径、`..`、符号链接、大小写碰撞。

`README.md` 必须在根上。frontmatter 里单独写 `summary`，一句话，不超过 200 个 Unicode 字符，不从标题推断。列表页只显示这句。

`config.json` 是配置的唯一事实。详情页配置 Tab 写的就是它。它不计入可执行 digest，更新时默认保留用户改过的值。

`.vibex-plugin/content.index.json` 由作者维护、`build` 严查、Host 再验。UI 不扫描磁盘猜内容。

## plugin.json

当前官方包用的形状（字段以仓库里真实包为准）

```json
{
  "$schema": "https://schemas.vibex.dev/plugin/v4/plugin.schema.json",
  "manifestVersion": 4,
  "apiVersion": "1.0",
  "id": "notes",
  "publisher": "you",
  "version": "0.1.0",
  "name": "Notes",
  "readme": "README.md",
  "engines": { "vibex": ">=0.1.3 <1.0.0", "pluginSdk": "^1.0.0" },
  "content": {
    "root": "contents",
    "index": ".vibex-plugin/content.index.json"
  },
  "config": {
    "schema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "entrypoints": {
    "worker": {
      "path": "dist/worker.mjs",
      "runtime": "node",
      "protocol": "1.1"
    },
    "app": {
      "root": "dist/app",
      "document": "index.html",
      "protocol": "1.0"
    }
  },
  "integrations": [],
  "interface": { "icon": "assets/icon.svg" }
}
```

`entrypoints.worker.runtime` 取 `node`、`python` 或 `native`。作者只写 `runtime`，不要再写已经废掉的 `format=javascript-esm`。

Worker 走协议 1.1（initialize 再 activate）。App 走协议 1.0。

### integrations

每项要有稳定 `id` 和 Host 认识的 `kind`。运行时只能绑定已声明项。

| kind | 作用 |
| --- | --- |
| `content.skill` | 把 `contents/skills/...` 投影给兼容 Agent |
| `content.mcp` | 托管 MCP，Host 按 session 拉起 |
| `content.hook` | Hook 资源 |
| `workflow.binding` | 把 `contents/workflows/` 暴露给 Composer / Automation |
| `file.opener` | 按扩展名、媒体类型或文件名后缀打开。只读预览写 `previewProvider`，可编辑页写 `editorSurface` |
| `artifact.preview` | Broker 管的预览 provider，可带 process argv |
| `app.surface` | Full Trust App。可编辑文本页用 `slot` 为 `artifact.editor` |
| `app.command` | 命令面板 |
| `app.toolbar` | 工具栏 |
| `app.status` | 状态栏，界面最多取 3 条 |
| `app.composer.slash` | Composer 斜杠 |
| `app.timeline.card` | 时间线卡片 |
| `app.settings.section` | 设置段 |
| `host.service` | 后台周期调用 Worker handler，`intervalSeconds` 最小 5 |

`depends/` 里的 Runtime 要在 manifest 的 `dependencies` 里显式引用。目录在不等于已经有执行权。锁的身份是 `id + version + target + digest`。

`depends.kind=plugin` 不被 Host inspect 和 CLI validate 接受。只声明 runtime 依赖。

`app.surface.slot` 稳定面只有 `plugin.detail.panel` 与 `artifact.editor`。`conversation.timeline.card` 会同时让 validate 和 inspect 失败。

## CLI

开发、校验、链接、诊断只走命令行。链接使用正在跑的 Host 的本机 token，调用 `plugin_control_import`。不要向用户索要 token。

```bash
vibex-plugin validate
vibex-plugin validate --json
vibex-plugin build
vibex-plugin test
vibex-plugin test --host
vibex-plugin install --link .
vibex plugin add --dev .
vibex-plugin doctor
vibex-plugin pack
vibex-plugin pack --output dist/notes.vxp
vibex-plugin uninstall
vibex-plugin uninstall --delete-data
```

`install` 现在只支持 `--link`。产品 CLI 也可以：`vibex plugin add --dev .` 链到正在跑的 Desktop 或 Server，不必再从界面拷 Dev grant。`--dev` 只负责 build；Host 用文件事件监视 digest 并发布候选代。

普通用户装发布物走 `vibex plugin add --profile file.vxp`、`--web <git>#tag`、GitHub Release `.vxp`（带 SHA-256 时校验）或桌面拖入 `.vxp`。`vibex plugin list` / `update` / `remove` / `gc-runtimes` 操作同一 Host catalog。`vibex plugin test --host` 与 `vibex-plugin test --host` 对着真 Host 走装、Skill 热更新、卸载。

`dev` 会先 build，再 link，再监视源码。digest 变了才重载。重载走候选代，失败则上一完整代仍对外可见。

`pack` 产出确定性 `.vxp`，并打印 `sha256:` 摘要。发布物带 README、config 初值、contents、depends、dist 和 `.vibex-plugin` 元数据。不带 `runtime/` 源码、source map、`.git`、`node_modules`、开发链接文件。

`doctor` 向 Host 问安装、激活、Runtime、surface、绑定和最近崩溃。不要指望它再吐 grants 字段。

## 开发流程

1. `init` 选最接近的模板。
2. 改 README 的 `summary` 和正文。
3. 在 `integrations` 里只声明你真要实现的槽。
4. 写 Worker 或 App，handler id 必须和声明一致。
5. `build`，看 `dist/` 和 `package.lock.json`。
6. `validate` 和 `test`。
7. 打开 VibeX，用开发工具拿到 host 和 grant。
8. `install --link .` 或直接 `dev`。
9. 在 `/plugins` 里启用，走一遍用户能看见的路径。
10. 要分发就 `pack`，把 `.vxp` 给人拖进去。

Harness 绿了不算完。文件页、预览、Runtime、远程行为必须对着正在跑的 Host 点过。

## Worker 协议

stdio，一行一条 JSON。顺序是 `initialize`（谈成 `1.1`）→ `activate` → 之后 `invoke` / `ping` / `dispose`。Worker 调 Host 用 `host.call`，带 `capability`、`operation`、`input`。

单帧上限 1 MiB。超时默认 30 秒。

handler id 正则

```text
^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]*)*$
```

setup 阶段只注册，不在外面偷偷干活。注册完成就冻结。重复、未声明、缺必填 handler，候选代失败。

## JavaScript / TypeScript SDK

包名 `@vibex/plugin-sdk`。导出

- `.` 与 `/protocol` 类型和常量
- `/worker` 定义 Worker
- `/app` 定义 App
- `/stdio` 跑 stdio 循环
- `/testing` harness

常量

- `VIBEX_PLUGIN_API_VERSION` 为 `"1.0"`
- `VIBEX_PLUGIN_PROTOCOL_VERSION` 为 `"1.1"`

### definePluginWorker

```ts
import { definePluginWorker } from '@vibex/plugin-sdk/worker';

export default definePluginWorker((registrar, environment) => {
  registrar.handle('hello', async (input, env) => {
    env.log.info('hello', { input });
    return { ok: true };
  });
  registrar.onDispose({
    dispose() {
      /* 关句柄 */
    },
  });
});
```

`registrar.handle(id, handler)`

- `id` 必须通过上面的正则，且写在 manifest 里
- `handler(input, environment)` 的 `input` 是 JSON，返回 JSON 或 Promise

`registrar.onDispose(disposable)` 收 `{ dispose() }` 或函数。卸载按反序调用。

`environment`

| 字段 | 含义 |
| --- | --- |
| `context.pluginId` | 插件 ID |
| `context.pluginVersion` | 版本 |
| `context.generation` | 当前激活代 |
| `context.packageClass` | `full-trust` 或 `isolated` |
| `context.grantedCapabilities` | Full Trust 下通常是 `["*"]` |
| `host.call(capability, operation, input?)` | 调 Host |
| `signal` | `AbortSignal`，dispose 时 abort |
| `log.debug/info/warn/error(message, fields?)` | 结构化日志 |

`activatePluginWorker(definition, environment)` 给测试或自托管用。`apiVersion` 不是 `1.0` 会抛 `sdk_incompatible`。已 dispose 再 `invoke` 抛 `worker_disposed`。找不到 handler 抛 `handler_not_found`。

### host.call

签名 `host.call<T>(capability, operation, input?)`。

catalog 里的名字是契约。当前 Host 实现参差不齐，按代码说话。

已经能当功能用的

- `artifact.preview` 的 `open` / `close`，打开要先拿到 Host 发的短命 handle（约 30 秒）
- `storage.kv` 的 `get` / `put` / `delete` / `list`，按插件 ID 隔离，进程内存储
- `log.*` 走 Worker 日志

会明确失败的

- `network.fetch` 返回 `network_denied`。Full Trust 请用语言运行时自己访问网络。Isolated 默认没有 `socket`/`connect`
- `files.*` 返回 `files_root_denied`，工作区根还没绑到这个 Worker
- `conversation.read.get`、`conversation.append.enqueueInput` 返回 `conversation_scope_denied`，除非会话已经绑到这个 Worker
- `agent.invoke` 返回 `handler_not_visible`

占位或未做完的会 `capability_unimplemented`。`storage.settings.*` 目前原样回传 input，不要当持久设置用，设置请写 `config.json`。`secrets.*` 目前只回 `{ "present": false }`。

### definePluginApp

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

`bridge`

| 成员 | 含义 |
| --- | --- |
| `pluginId` | 插件 ID |
| `generation` | 当前代 |
| `invoke(handler, input?)` | 调本代 Worker |
| `subscribe(channel, listener)` | 订阅，返回取消函数 |
| `ready()` | 告诉 Host 页面已挂上 |
| `artifact` | 仅 `artifact.editor` 文件页存在 |

`bridge.artifact`

| 方法 | 含义 |
| --- | --- |
| `name` | 文件名，不是本机绝对路径 |
| `readText()` | 得到 `{ name, content, revision }` |
| `writeText(content, expectedRevision)` | 按修订号写入。外部改过会冲突，不要盲覆盖 |

App 协议是 1.0。不要在 App 里自己去读 Host 磁盘路径。

### testing

```ts
import { createWorkerHarness, createGenerationHarness } from '@vibex/plugin-sdk/testing';

const worker = await createWorkerHarness(definition, {
  context: { pluginId: 'you.notes', pluginVersion: '0.1.0', generation: 1 },
});
await worker.invoke('hello', {});
// worker.hostCalls 记录对 host.call 的调用
await worker.dispose();

const gen = await createGenerationHarness(definition, {
  requiredHandlers: ['hello'],
});
const next = await gen.activateCandidate(definition);
await gen.dispose();
```

`createGenerationHarness` 用来演候选代切换。缺 required handler 会在激活时失败。

### stdio

```ts
import { runStdioPluginWorker } from '@vibex/plugin-sdk/stdio';
import definition from './worker.js';

await runStdioPluginWorker(definition);
```

`init` 打出来的 Node Worker 入口就是这样挂上的。

## Python SDK

包名 `vibex-plugin`，源码在 `sdk/python`。需要 Python 3.11+。Host 锁的 Isolated/托管解释器是 CPython 3.12.11（python-build-standalone）。

```python
from vibex_plugin import define_plugin_worker, run_stdio_plugin_worker

def setup(registrar, environment):
    def hello(input, env):
        env.log.info("hello", {"input": input})
        return {"ok": True}

    registrar.handle("hello", hello)

if __name__ == "__main__":
    run_stdio_plugin_worker(define_plugin_worker(setup))
```

异步入口用 `run_stdio_plugin_worker_async`。

`environment.context` 是带属性的字典。`plugin_id`、`plugin_version`、`generation`、`package_class`。

`environment.host.call(capability, operation, input=None)` 是 async。

`HostClient` 另提供 `fetch_url`、`read_local_file`、`write_local_file`，给 Full Trust 本机 IO 用，不要和尚未接好的 `files.*` Broker 混为一谈。

测试

```python
from vibex_plugin import create_worker_harness, create_generation_harness, MemoryHostClient
```

## Rust SDK

crate 名 `vibex-plugin-sdk`，路径 `crates/plugin-sdk`。MSRV 1.85。stdio 用 tokio current-thread。

```rust
use vibex_plugin_sdk::{
    define_plugin_worker, run_stdio_plugin_worker_blocking, PluginSdkError,
};
use serde_json::json;

fn main() {
    let definition = define_plugin_worker(|registrar, _env| {
        registrar.handle_sync("hello", |input, _env| {
            Ok(json!({ "received": input }))
        });
        registrar.on_dispose(|| async { Ok(()) });
    });
    if let Err(error) = run_stdio_plugin_worker_blocking(definition) {
        eprintln!("{error}");
    }
}
```

`PluginRegistrar`

- `handle(id, async_fn)` 异步 handler，返回 `Result<Value, PluginSdkError>`
- `handle_sync(id, fn)` 同步包装
- `on_dispose(async_fn)` 清理钩子，反序执行

`WorkerEnv`

- `context()` / `replace_context()`
- `host`（`HostClient`）
- `log.debug/info/warn/error`
- `is_cancelled()` / `cancel()`
- `call(capability, operation, input)` 异步转发 Host

`run_stdio_plugin_worker` 是 async。`run_stdio_plugin_worker_blocking` 给 `main`。

Isolated 构建建议 `--no-default-features --features isolated`，避免把文件系统和网络辅助编译进去。

测试模块导出 `create_worker_harness`、`create_generation_harness`、`MemoryHost`。

crate 当前 `publish = false`，用 path 依赖即可。

## 测试流程

本地

```bash
vibex-plugin test
```

模板若带 `test/plugin.test.mjs`，会用 `createWorkerHarness` 调 `hello` 一类 handler。Python / Rust 用各自测试目录。

对着 Host

1. `dev` 或 `install --link .`
2. 启用插件
3. 点开你声明的每一个槽。斜杠、预览、保存冲突、关掉插件后入口是否消失
4. `doctor` 看崩溃环和 `mcpRebindingRequired`

更新失败时，界面和 doctor 应仍指向上一完整代。不要靠杀掉 VibeX 当回滚。

## 更新流程

链接开发目录改文件，`dev` 会编新 digest 并发布候选代。校验失败则不切出去。

已安装的快照包，桌面可以走更新命令（有新版本或你指定 digest）。更新默认留 `config.json`。新 schema 不认识旧键时，要在包里写清迁移，不能让旧 Worker 去开未知库。

回滚用「恢复上一版」。Host 只在留得住已验证 rollback digest 时提供。没有上一份就失败，不要装成成功。

## 给别人安装（还没有市场）

作者侧

```bash
vibex-plugin pack --output notes.vxp
```

把 `.vxp` 发给对方。对方打开 `/plugins`，添加或拖入。装完默认禁用，对方自己开。

同 ID 冲突时对方选保留或替换。替换不会自动继承另一发布者的权限和数据。身份是发布者加插件 ID。

远程 Host 可用 `plugin_install` / `plugin_update` / `plugin_uninstall`，改的是那台 Host。

## 生命周期（你必须配合的部分）

启用意图和活着的激活代是两件事。用户想开，但依赖没就绪，贡献不会进目录。

卸载或禁用时，Host 反序停 `host.service`、dispose Worker、收回贡献。依赖你的其它包会退出就绪，意图可以还在。你再启用，它们会尝试重挂。

`onDispose` 用来关句柄。不要把唯一该落盘的状态拖到 dispose。正常请求里就提交。

Host 重启后，仍启用且有 Worker 的包会按活代恢复。链接包若快照丢了，会按源目录再冻一份，身份变了就失败。

## Isolated

`packageClass` 为 `isolated` 才进沙箱。macOS 用 `sandbox-exec`。Linux 用 `bwrap --unshare-net` 加 seccomp，或 Landlock 加 seccomp。Windows 用 AppContainer（默认没有 `internetClient`）再加 Job（关 Job 杀进程，内存 256MiB）。

默认不允许 `socket` / `connect` / `accept` / `bind`。清单在 `packages/plugin-contract/isolated/`。

没有对应沙箱的机器上，Isolated 包硬失败，不会静默改成 Full Trust。

## 注意事项

handler、integration、content index 三者对不上，候选代过不去。

不要按插件 ID 让 Host 特判你。要新能力，先加公共 kind 或 Host API，再在包里声明。

不要把 Workflow gateway token 写进每个 MCP。插件 MCP 用短命、带作用域的 token。

官方 MCP 只进启用后的新会话。文档里不要写「打开开关当前对话立刻多工具」。

Full Trust 等于本机权限。README 写清联网、读盘、起进程。用户装你就是信你。

`summary` 写广告句，列表页会很难看。写它实际干的那一件事。

Agent 原生插件和 VibeX 产品包可以同目录共存，执行权和信任仍分开。
