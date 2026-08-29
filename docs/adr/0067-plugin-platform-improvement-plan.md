---
status: accepted
date: 2026-08-28
decision-makers:
  - VibeX maintainers
---

# 插件平台改进计划（市场、单路作者链、可运行脚手架）

本文是 [ADR-0066](0066-plugin-marketplace-authoring-and-session-honesty.md) 的落地计划。
按阶段给出范围、顺序、验收和迁移。本文件不代替 0066 的产品决定。实现时以 0066 为准；
本计划冲突时改计划，不改决定。

当前阶段**只接受本文件与 0066**。代码、官网 API、脚手架与 Skill 的改动必须另开实现任务，
并按阶段验收。

## Goal

用户在设置 → 插件能：看懂已有会话不会获得新插件能力；从官网市场发现并安装官方与社区包；
在弹窗里预览并确认 Full Trust；对已安装且来源锁定的包看到「可更新」并更新。

作者能：`init` 得到 Host 可运行的包；只用 CLI 完成 build / test / 链接 / pack；按插件
开发 Skill 走完 Host 旅程。官方包不再偷偷出现在空 catalog 里。

## Non-goals

- 不恢复逐 capability 授权、Isolated v5 默认路径或 Trusted Native 弹窗。
- 不做首次推荐批量启用。
- 不把开发 MCP 修完再删除；直接删除 `plugin-dev` 产品面。
- 不在 Companion 上执行插件 Worker 或写 catalog。
- 不开放待审包。不上架付款。
- 不在本计划把 `app.command` 等无官方范例的孔做成默认 `init` 模板。

## Phase 0 — 契约与词表

把 0066 的术语写入根 `CONTEXT.md`，并在相关 ADR 顶部加指向 0066 的修订注记：

| 术语 | 含义 |
| --- | --- |
| 插件目录 Tab | 设置 → 插件上的「已安装」与「插件市场」 |
| 官方分类 | 官网已发布且 `category=official` 的条目，全量拉取，市场 Tab 默认置顶 |
| 社区目录页 | 非官方已发布条目的一页，默认 50 条 |
| 安装物身份 | `owner/plugin-name/tag/version` |
| 来源锁 | 已安装包的 `marketplace` 或 `github` 远端证据，决定更新从哪拉 |
| 可更新 | 来源锁有效且远端有更新 tag 或更大 semver |
| 安装预览弹窗 | 安装或更新前的身份、能力与 Full Trust 确认 |

同步：`docs/plugins/user-guide.md`、`developer-guide.md`、`official-plugins.md` 按 0066
重写发现/安装/生效段落。产品官网指南 `install-from-marketplace.md` 与 Host 市场 Tab
使用同一套命令和四元组。

**验收：** CONTEXT 与 0066 用词一致；旧「builtin 不可卸载」「开发 MCP 链接」不再作为现行
产品叙述。

## Phase 1 — 会话提示与作者单路（不依赖市场 API）

### 1.1 插件页提示

在 `ProductPlugins` 目录页，`plugins.productSubtitle` 使用 0066 第 1 节的单句文案。
详情页不重复。

### 1.2 `init` 产出可运行包

改 `packages/plugin-cli/src/scaffold.ts` 及测试：

- Node 系模板写 `runtime/worker.mjs` + `runtime/main.mjs`（`runStdioPluginWorker`）。
- 测试从定义模块导入；无 Worker 模板用 fixture 导出。
- `engines.vibex`：`>=0.1.3 <1.0.0`。
- 增加可编辑文件 Tab 模板（或把 `file-tab` 说明改成预览，另加 `editor-tab`）。名字与产物
  必须一致。
- CLI 测试覆盖：init 后 `validate` 通过；打包后的 `dist/worker.mjs` 含 stdio 循环；
  `vibex-plugin test` 在临时目录下仍绿。

### 1.3 删除开发 MCP，Skill 改为 CLI 规范

- 插件开发包去掉 `content.mcp`、`devMcp`、`contents/mcps/plugin-dev.json`。
- `crates/plugins` / `crates/vibex-mcp` / `src-tauri` 注入去掉 `plugin-dev` 产品。
- 设置页开发工具对话框去掉 endpoint/凭据；需要该产品时走向市场官方分类（Phase 3
  接上之前，可暂时链到「添加本地目录」的 `add --dev` 说明）。
- `vibex-plugin install --link` 与 `dev` 改为与 `vibex plugin add --dev` 同一
  `plugin_control_import` 路径，拒绝 `VIBEX_PLUGIN_DEV_TOKEN`，不再依赖
  `VIBEX_PLUGIN_DEV_GRANT`。
- 重写 `assets/plugins/plugin-development` 的 Skill、README、参考：完整开发与测试
  规范以 CLI 为准，含 `test --host`。

### 1.4 Host 旅程门

- `vibex plugin test --host` 作为 Node/App/MCP 模板与官方包 CI 的必过项。
- 最短旅程：安装或链接 → 启用 → 点到该模板声明的用户能力 → 卸载后源目录仍在。
- Office / Workflow Creator / 插件开发包在实现阶段按各自 integration 补旅程，不把
  harness 绿当成完成。

**验收：** 新用户能在插件页读到会话提示；`init --template node-worker` 的包能被 Host
拉起 Worker；Agent 按 Skill 只用 CLI；仓库内不再出现 `plugin_dev_link_*` 产品面。

## Phase 2 — 官网 Catalog API

仓库：`~/Projects/vibex-site`。不改审核模型（待审不上架）。

新增 `/api/marketplace/v1/`（或等价版本化前缀），实现 0066「Marketplace Catalog API」
六类只读接口。相对现有 `GET /api/marketplace/list`：

- 官方与社区分流；社区默认 `limit=50`。
- 搜索打全量已发布。
- 每条带 owner、plugin-name、tag、version、digest、sourceKind、downloadUrl。
- `versions` 供 Host 比较「可更新」。
- artifact 必须有完整性证据（sha256）；GitHub 源给出可钉死的 tag。

现有 `GET /api/marketplace/artifact/:author/:plugin` 可保留给 CLI，v1 artifact 与它
返回字段对齐并补 tag/digest。CORS：允许桌面与 `vibex-server` 所在的回环与用户配置
的 Host 来源读取公开目录。

**验收：** 无登录可拉官方全量与社区 50 条；搜索能命中第 51 条社区包；待审包 404；
契约有测试（`tests/marketplace.test.ts` 或新增 catalog 测试）。

## Phase 3 — Host 市场 Tab、预览弹窗、来源锁、可更新

### 3.1 目录页两个 Tab

`/plugins`：已安装 | 插件市场。市场 Tab 打开时默认官方分类置顶，社区 50 条在后。
搜索框在市场 Tab 打官网 search。Companion / `plugin.write` 缺失时市场只读或隐藏安装。

### 3.2 安装预览 + Full Trust 弹窗

市场「安装」、拖入 `.vxp`、文件选择器、CLI import 前的桌面确认，共用同一弹窗组件。
字段与 0066 第 5 节一致。取消则不 import。自动启用不在本阶段做；安装后仍默认禁用
（与现行一致），避免未确认启用。

### 3.3 来源锁与可更新

`InstalledPlugin` / control-plane 持久化来源锁。打开已安装 Tab 或显式「检查更新」时：

- `marketplace` → Catalog `versions`
- `github` → 该仓库的 tag/release（CLI 当初怎么钉就怎么问）

比较后在已安装行显示「可更新」与更新按钮。更新走预览弹窗 + 现行
`plugin_control` 更新/替换，保留 `config.json`。

`vibex plugin add --web <github>` 写入 `sourceKind=github`。
`vibex plugin add --web https://vibex.xforever.xin/marketplace/<owner>/<name>`
写入 `sourceKind=marketplace`。`plugin update` 只跟随来源锁。

### 3.4 官方包不再预装

- 停止启动时 `materialize_builtin_plugins` 自动 import 到 catalog。
- 官方五件套在官网以 `category=official` 上架（owner 建议 `vibex`）。
- Host 家族可继续打包快照目录，仅供离线市场官方分类安装。
- 迁移：已有 builtin 记录改为官方市场来源锁（owner=`vibex`，name=现 plugin id，
  tag/version=当时版本），允许卸载。不要删用户已启用状态。
- 修订测试 `crates/plugins/tests/official_host_catalog.rs` 等「启动即五件套」断言。

**验收：** 新数据目录启动后已安装列表不含官方五件套；市场 Tab 官方分类能装 Office；
弹窗可见 Full Trust 句；GitHub 安装的包更新走 GitHub；市场安装的包在官网发新
tag 后已安装行出现「可更新」。

## Phase 4 — 稳定面收敛与官方包对齐

- CLI validate 与 Host inspect 对 `depends.kind=plugin`、非法 `app.surface.slot`
  给出同一错误码。
- Skill / `init` / SDK 导出注释只叙述 0066 第 7 节稳定面。
- 官方包（现 submodule）继续只使用稳定面；不把 command/toolbar 塞进默认模板。
- 插件开发 Skill 与 `test --host` 覆盖官方参考路径：Office 预览或 Workflow 编辑页
  至少一条。

**验收：** 一份仅含稳定面的 `init` 包能过 CLI+Host；一份故意写
`conversation.timeline.card` slot 或 `kind: plugin` 依赖的包在 validate 与 inspect
都失败。

## Order and dependencies

```text
Phase 0
  → Phase 1（提示、init、删 MCP、Skill、host test 门）
  → Phase 2（官网 v1 Catalog）
  → Phase 3（市场 Tab、弹窗、来源锁、取消 builtin 预装）
  → Phase 4（稳定面与官方包）
```

Phase 1 不阻塞于官网。Phase 3 必须等 Phase 2 的官方/社区/versions/artifact 可用。
Phase 4 可与 Phase 3 部分并行，但「官方包不再预装」完成前，Host 旅程仍可对
submodule 路径跑。

建议 PR 切分：

1. 文案与 CONTEXT（Phase 0 + 1.1）
2. scaffold + CLI 测试（1.2）
3. 删除 plugin-dev MCP + Skill 重写（1.3）
4. `test --host` 接到模板 CI（1.4）
5. 官网 Catalog v1
6. Host 市场 Tab + 弹窗
7. 来源锁 + 可更新 + CLI origin
8. 取消 builtin import + 迁移
9. validate/inspect 对齐稳定面

## Risks

- **空 catalog 第一印象。** 有意。用市场 Tab 官方置顶补发现，不回到预装。
- **官网与 Host 域名。** 用户指定 `https://vibex.xforever.xin/marketplace`。实现时以
  该 origin 为默认 Catalog base，可配置覆盖；与文档里曾出现的拼写差异不得导致
  第二套权威。
- **四元组与 Publisher+ID。** 来源锁不能取代包身份。更新必须校验新包 publisher/id
  与现 membership 一致，否则走替换冲突而不是静默更新。
- **GitHub API 限额。** 已安装列表检查更新要有超时、缓存和失败降级。
- **离线官方缓存。** 若发行物携带快照，必须与官网同一 digest 算法；联网后以官网
  versions 为准标「可更新」。

## Test matrix

| 旅程 | 期望 |
| --- | --- |
| 打开已安装 Tab | 副标题后有缩小 2px 的会话提示 |
| `init` node-worker → build → Host 启用 | Worker 不立即退出，handler 可 invoke |
| Skill 指引下 `add --dev` | 不出现开发 MCP 工具；不向用户要 token |
| 市场 Tab 默认 | 官方全量在上，社区 50 条在下 |
| 搜索稀有社区包 | 能命中不在首页 50 里的条目 |
| 安装弹窗取消 | catalog 无新 membership |
| 安装确认 | 默认禁用，新会话才有 MCP/工具 |
| GitHub `--web` 安装后官网发新版 | 已安装不显示来自官网的可更新 |
| 市场安装后官网新 tag | 已安装显示可更新，更新后版本与 digest 变 |
| 新数据目录 | 启动后无五件套；可从官方分类安装并卸载 |
| 旧数据目录 | builtin 变为可卸载的官方来源锁，启用状态保留 |

## Rollback

- 市场 API 失败时，市场 Tab 显示错误，已安装 Tab 与本地 `.vxp` 导入不受影响。
- 取消 builtin 预装若必须回退，只能通过「从离线官方缓存一键安装」的显式动作，
  不得恢复静默 `sourceKind=builtin` 且不可卸载。
- 开发 MCP 删除后不回滚；调试需求以 CLI 为准。
