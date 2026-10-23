# init 模板产物

```text
vibex-plugin init <dir> --publisher <id> --template <name>
```

`init` 立刻 `build`。默认 `full`。可用名与 `vibex-plugin toolchain` 的 `templates` 数组一致。

| 模板 | 清单 integrations | 源码 | 作者必须补齐 |
| --- | --- | --- | --- |
| `skill` | `content.skill` | `contents/skills/hello/SKILL.md` | 改 summary 与 Skill 正文。生成测试用 `import.meta.url`，改为 fixture 导出 |
| `mcp` | `content.mcp` | `contents/mcps/hello.json` + `runtime/mcp.mjs` | 实现 MCP 进程。`init` 只写了一行 ready JSON |
| `hooks` | `content.hook`（`session.before_prompt`） | `contents/hooks/before-prompt.md` | 改 Hook 正文。当前 Host 无 Hook 运行时 |
| `file-tab` | `.txt` 的 `file.opener`+`artifact.preview`，以及 `plugin.detail.panel` | Node Worker 定义 + stdio 入口、`runtime/app.mjs` | 这是只读预览 + 详情面板 |
| `editor-tab` | UTF-8 文件的 `file.opener.editorSurface` + `artifact.editor` | Node Worker 定义 + stdio 入口、可编辑 App | 实现 `surface.createSession` 与 `bridge.artifact` |
| `full` | `workflow.binding` + file-tab 那一组 | Node Worker 定义 + stdio 入口、App、workflow JSON | 改产品内容 |
| `ts-worker` | `workflow.binding` | `runtime/worker.ts` 定义，`runtime/main.mjs` 调 `runStdioPluginWorker` | 改 handler |
| `node-worker` | `workflow.binding` | `runtime/worker.mjs` 定义，`runtime/main.mjs` 调 `runStdioPluginWorker` | 改 handler |
| `python-worker` | `workflow.binding` | `runtime/worker.py`（已含 stdio） | `requires-python >=3.12` |
| `rust-worker` | `workflow.binding` | `runtime/src/main.rs`（已含 stdio），清单 path 暂为源码 | 编译二进制，把 `entrypoints.worker.path` 改到 `dist/` 下的产物 |
| `host-service` | `host.service`（handler `hello`，30s） | Node Worker 定义 + stdio 入口 | 改 handler 与间隔 |
| `host-chrome` | 六个 chrome 槽位各一条 | Node Worker + App | 改 title / prompt / handler 返回值 |
| `provider-import` | `provider.model.importSource` | Node Worker | handler 返回 `{ providers }` 或数组 |
| `provider-catalog` | `provider.model.catalog` | 静态 JSON | `catalogs/example.json` 两条无密钥模板 |
| `panel` | `app.panel`（`defaultPosition: left`） | Node Worker + Vite Federation `src/views/view.tsx` | 改面板 UI；`run dev` 走 HMR |
| `kanban-view` | `app.kanban.view` | Node Worker + Vite Federation | 改视图 UI；`run dev` 走 HMR |

`init` 写入的 `engines` 为 `vibex: ">=0.1.3 <1.0.0"`、`pluginSdk: "^1.0.0"`。`package.json` 的脚本假定已安装 `vibex-plugin`；在 VibeX 源码树里改用 `node packages/plugin-cli/dist/cli.js`。

Node 模板测试从 `runtime/worker.mjs`（定义）导入。从 `dist/worker.mjs` 导入会启动协议循环。

`host-chrome` 写出 `app.command` / `app.toolbar` / `app.status` / `app.composer.slash` / `app.timeline.card` / `app.settings.section`。chrome 槽位随激活代刷新。结构面 remote 在 `vibex plugin run dev` 期间由 Host `loadRemote` 指向 Vite。
