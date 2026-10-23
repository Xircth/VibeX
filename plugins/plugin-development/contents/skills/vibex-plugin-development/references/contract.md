# 产品包契约

对照 Host 0.1.3、协议 1.1、SDK 1.0.0。字段以本机 `packages/plugin-sdk/src/manifest.ts`（或 `vibex-plugin toolchain` 打印的 `js`）和 CLI `validate` 为准。

## 目录

```text
my-plugin/
├─ .vibex-plugin/plugin.json
├─ .vibex-plugin/content.index.json
├─ .vibex-plugin/package.lock.json    # pack 写入
├─ README.md                          # frontmatter.summary 必填
├─ config.json                        # 配置唯一事实
├─ contents/                          # Skill / MCP / Hook / Workflow / 其它
├─ depends/                           # 仅当 dependencies 引用时
├─ runtime/                           # 作者源码，不进 .vxp
├─ src/                               # Federation 面板源码（panel / kanban-view）
└─ dist/                              # build 输出
```

路径相对包根，用 `/`。拒绝绝对路径、`..`、符号链接。

`vibex-plugin build`：校验 summary、schema、索引、integrations、dependencies；编译 `runtime/main.mjs` → `dist/worker.mjs`；编译 App、Federation remote 与 `managedRuntime.source`。

`vibex-plugin pack`：写入 `package.lock.json` 与 `signature.json`，`.vxp` 收录 README、config 初值、contents、depends、dist、`.vibex-plugin`。不含 `runtime/`、`src/`、`test/`、`package.json`、source map。

## plugin.json

- `manifestVersion` 4，`apiVersion` `"1.0"`，`readme` `"README.md"`。
- `engines.vibex` 写成 `>=0.1.3 <1.0.0`；`engines.pluginSdk` 写成 `^1.0.0`。
- Worker：`path`、`runtime`（`node`|`python`|`native`）、`protocol` `"1.1"`。省略 `format`。
- App：`root`、`document`、`protocol` `"1.0"`。
- v4 缺省执行类 `full-trust`。Host 按 Full Trust spawn Worker。
- `permissions` 可省略；出现时只作兼容元数据。
- `dependencies[].kind` 只能是 `runtime`；`descriptor` 指向 `depends/` 下真实文件。CLI `validate` 与 Host inspect 都拒绝 `kind: "plugin"`。

## 内容索引

```json
{
  "schemaVersion": 1,
  "items": [
    {
      "path": "contents/skills/hello/SKILL.md",
      "kind": "skill",
      "title": "Hello"
    }
  ]
}
```

`items[].path` 必须是 `contents/` 下已存在的文件。Skill integration 的 `resource` 指向技能目录（内含 `SKILL.md`）；索引项指向具体文件。

## integrations

每项要有稳定 `id`（`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`）和 Host 认识的 `kind`。至少一项。运行时只能绑定已声明项。

| kind | 作用 |
| --- | --- |
| `content.skill` | 把 `contents/skills/...` 投影给兼容 Agent。可写 `targets` |
| `content.mcp` | 托管 MCP。资源 JSON 见下 |
| `content.hook` | Hook 资源；需 `event`。清单可校验；当前 Host 无 Hook 运行时 |
| `workflow.binding` | 把 `contents/workflows/.../workflow.json` 暴露给 Composer / Automation |
| `file.opener` | 按 `extensions`、`fileNameSuffixes` 或 `mediaTypes` 打开。恰好一个 `previewProvider` 或恰好一个 `editorSurface` |
| `artifact.preview` | Broker 管的预览 provider，可带 `process.argv` |
| `app.surface` | Full Trust App。`slot` 为 `plugin.detail.panel` 或 `artifact.editor` |
| `app.command` | 命令面板。`title`、`handler` |
| `app.toolbar` | 工具栏。只可添加 |
| `app.status` | 状态栏。超出三项进溢出菜单 |
| `app.composer.slash` | Composer 斜杠。`prompt` 插入输入框 |
| `app.timeline.card` | 时间线卡片。`handler` 为 `surface.createSession` |
| `app.settings.section` | 通用设置页内嵌区块 |
| `app.settings.page` | 设置侧栏整页 |
| `app.tab` | 中央顶级 Tab |
| `app.panel` | 工作区 Dockview 面板。`defaultPosition` 为 `left` 或 `center` |
| `app.kanban.view` | 看板 Tab 内的一页视图 |
| `app.composer.action` | Composer 提交前动作。需要 `handler` 或 `prompt` |
| `host.service` | 后台周期调用 Worker handler；`intervalSeconds` 下限 5，缺省 30；同一包最多 8 条 |
| `provider.model.importSource` | 模型供应商导入来源 |
| `provider.remote.provisioner` | 远程 Host 供给器。`provisionKind` 为来源标记 |

`init` 模板覆盖上表稳定面。`content.hook` 仅通过清单校验。`icon` 取 `@vibex/plugin-contract/catalog/icons`。

`file.opener` 的 `fileNameSuffixes` 必须以 `.` 开头，只含字母、数字、点、短横、下划线。编辑面的 `app.surface.slot` 必须是 `artifact.editor`，`appEntrypoint` 为 `app`，`handler` 为 `surface.createSession`。

结构面可选 `remote`：`name`、`entry`（通常 `dist/remoteEntry.js`）、`module`。

`host.service` 在启用后按间隔 tick；上一轮未完成则跳过。

Agent 侧贡献在新开或 rebind 会话中注入。UI 与 Provider 贡献启用即出现、禁用即撤下。

## 托管 MCP

`contents/mcps/*.json`：

```json
{
  "managedRuntime": {
    "source": "runtime/mcp.mjs",
    "entrypoint": "dist/mcp/hello.mjs",
    "protocolRevision": "2026-07-28",
    "defaultBinding": "all-compatible-agents"
  }
}
```

或官方 Host 家族二进制：

```json
{
  "managedRuntime": {
    "kind": "hostFamilyBinary",
    "binaryId": "vibex-mcp",
    "product": "session",
    "protocolRevision": "2026-07-28",
    "defaultBinding": "all-compatible-agents"
  }
}
```

`protocolRevision` 必须是 `2026-07-28`。`defaultBinding` 只能省略或为 `all-compatible-agents`。hostFamilyBinary 必须带 `binaryId`。包内 MCP 必须能解析 `entrypoint`；`source` 若出现也必须存在，并由 `build` 编译到 `entrypoint`。

官方产品面：`session`、`delegation` 走 `binaryId: "vibex-mcp"`；Workflow Creator 走 `binaryId: "vibex-workflow-mcp"`。第三方包使用自有 `entrypoint`。

已注入的 STDIO MCP 通常不会热增到旧会话。binding 变化后提示用户新开或 rebind 会话。

## 可编辑文件 Tab

1. `file.opener`：`extensions` / `fileNameSuffixes` / `mediaTypes` 之一，并设 `editorSurface`。
2. `app.surface`：`slot: artifact.editor`，`handler: surface.createSession`。
3. Worker 注册该 handler。
4. App：`readText()` 保留 revision；`writeText(content, expectedRevision)`。冲突码 `artifact_revision_conflict`。

Host 持有规范路径。App 只获得文件名、revision 与 `bridge.artifact`。参考 `vibex.workflow-creator`。

只读预览用 `previewProvider` + `artifact.preview`，一个 opener 只写一个 target。参考 `vibex.office`。

## Workflow 资源

`workflow.binding` 的 JSON 至少有 `label`。`init` 模板还写 `entrypoints` 与 `handler`。Office 另有 `promptBlocks`、`requires`、`artifactIntent`。Host 会把 integration `id` 写进该对象。沿用 Agent 会话的权限与模式字段。

## Runtime 依赖

`depends/runtimes/*.json` 由 `dependencies` 显式引用。目录存在不授予执行权。锁的身份是 id + version + target + digest。启用时 Host 必须锁住并能 probe 通过。参考 Office 的 `officecli`：声明 `entrypoint`、按平台分发、`probe.argv` 与版本串。
