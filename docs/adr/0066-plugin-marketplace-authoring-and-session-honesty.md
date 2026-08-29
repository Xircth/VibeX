---
status: accepted
date: 2026-08-28
decision-makers:
  - VibeX maintainers
---

# 插件市场、单路作者工具链与会话生效诚实性

本决定把插件平台从「Host 预装官方包 + 多条半截开发路径」收成一条用户能走完的产品：
市场发现与安装、诚实的 Full Trust 确认、可运行的作者脚手架、CLI 单路开发测试，以及
「已有会话不会热挂插件」的页面提示。

不采纳「首次进入就推荐批量启用官方插件」。官方能力改由市场官方分类安装，不再随
Host 自动进入 catalog。

## Context

当前控制面已经能安装、启停、链接开发和投影 Skill/MCP，但真实用户路径不完整：

1. 设置 → 插件页副标题只说「通过可安装的插件为 VibeX 增加新能力」，用户打开开关后
   当前会话往往没有新工具。官方 MCP 只进入启用之后的新会话或 rebind 会话，这个事实
   没有出现在该页。
2. 官方五件套以 `sourceKind=builtin` 预装进 catalog，默认禁用、不能当快照卸载。磁盘
   上有包不等于已启用，也不等于用户主动选择过。
3. `vibex-plugin init` 写出的 Node Worker 没有 stdio 循环，Host 启动即退出；`file-tab`
   实际是只读预览；测试用 `import.meta.url` 在 `vibex-plugin test` 下会找不到文件。
4. 开发链接同时存在产品 CLI、Plugin Dev HTTP、开发工具对话框和开发 MCP。开发 MCP
   只返回 `pending_confirmation`，不能当调试面。
5. 产品官网 `~/Projects/vibex-site` 已有 `/marketplace` 与
   `/api/marketplace/list`、`/api/marketplace/artifact/:author/:plugin`，但 Host 没有
   市场 Tab，也没有按官方/社区分页的目录 API。安装预览和 Full Trust 确认不完整。
6. SDK/CLI 列出的 integration 与 `host.call` 并不都在 Host inspect、UI 和官方包上闭环。
   harness 绿不能证明文件页、预览、Runtime 或 MCP 已在 Host 上可用。

相关既有决定：ADR-0046 生命周期与 SDK 边界；ADR-0047 产品目录与详情 Tab；ADR-0048
Full Trust；ADR-0051 托管 MCP；ADR-0054 Host 家族分发；ADR-0055 官方 MCP 字节随 Host
分发、由插件激活；ADR-0057 会话增强与多智能体为内置不可卸载插件。本决定修订其中与
「builtin 预装、不可卸载、多路开发入口」冲突的部分。

## Decision

### 1. 插件页提示会话生效边界

设置 → 插件目录页副标题为一条句子：

> 通过插件扩展平台能力，新建会话后生效

不另开帮助页，不解释 MCP 或 rebind 实现。产品语义是：Agent 工具清单、托管 MCP 注入
与依赖它们的 Composer 入口以**新会话或 rebind 之后的会话**为准。Skill 文件投影若在
启用当下已经完成，仍不得把当前会话说成已经具备完整插件能力。

不在首次进入时推荐批量启用任何插件。

### 2. 官方插件不再预装进 catalog

Office、会话增强、多智能体协同、Workflow Creator、插件开发 **不再**以
`sourceKind=builtin` 自动写入 Host catalog，也不再「随 Host 安装、不能卸载」。

它们作为官网市场的 **官方分类** 上架。用户从市场 Tab 或 CLI 安装后，与其它包一样
默认禁用，可以卸载。Host 家族仍按 ADR-0055 携带官方 MCP **二进制**（`vibex-mcp`、
`vibex-workflow-mcp`）；磁盘上有二进制不等于已安装插件，更不等于已注入会话。

Host 发行物可以附带官方包快照，仅作为市场官方分类的**离线安装缓存**。离线安装仍走
与在线市场相同的预览和 Full Trust 确认，origin 记为官方市场。不得在启动时静默
`import`。已有数据目录里的 builtin 成员迁移为官方市场来源的已安装包，允许卸载，
不再禁止 remove。

修订 ADR-0057「不能卸载的内置插件」与 ADR-0055 中「builtin 插件默认存在于 catalog」
的表述。原生 Workflow Studio 仍不依赖 Workflow Creator 插件；未安装该插件时，
`*.vibex-workflow.json` 不走插件编辑面。

### 3. `init` 必须产出 Host 可运行的包

`vibex-plugin init` 的完成标准是：对选用模板，`build` / `validate` / `test` 通过，
且按该模板声明的 integration 能在真实 Host 上激活并完成对应的用户路径。

固定约定：

- Node / TS / file-tab / full / host-service：写出 `runtime/worker.mjs`（或 `.ts`）
  定义模块与 `runtime/main.mjs` 的 `runStdioPluginWorker` 入口。`build` 打包
  `main.mjs` → `dist/worker.mjs`。测试从定义模块导入，禁止从 `dist/worker.mjs`
  导入，禁止用 `import.meta.url` 读插件根。
- `engines.vibex` 为 `>=0.1.3 <1.0.0`，`engines.pluginSdk` 为 `^1.0.0`。
- 模板名与产物一致。`file-tab` 表示 `.txt` 只读预览加详情面板。可编辑 UTF-8 文件
  Tab 使用独立模板（`file.opener.editorSurface` + `app.surface(slot: artifact.editor)`），
  对齐 Workflow Creator。
- Python 模板保持 `run_stdio_plugin_worker`；Rust 模板的清单 path 指向编译产物说明，
  并在 README 写明 `vibex-plugin build` 不编译 Rust。
- 无 Worker 模板的测试用模块导出的 fixture，不读磁盘路径。

作者 Skill 与 CLI help 只描述上述产物，不保留「init 之后还要手补 stdio」作为默认步骤。

### 4. 开发与测试收成 CLI 单路，移除开发 MCP

开发、校验、链接、诊断只走命令行。产品命令是：

```text
vibex-plugin init | build | validate | test | pack | toolchain
vibex plugin add --dev .
vibex plugin test --host
vibex plugin pack
vibex plugin add --profile | --web
```

`vibex plugin add --dev .` 是链接本机目录的唯一产品入口：build、validate、经本机
Host token 调用 `plugin_control_import`（`developerLink`），尝试启用，并监视 digest。
Host 未运行时写入 `~/.vibex/imports/links.jsonl`。

删除插件开发包的 `content.mcp`（`plugin_dev_link_request` / `plugin_dev_link_status`）、
根配置 `devMcp`、以及 `vibex-mcp` 的 `plugin-dev` 产品面。不要用半截 MCP 当调试器。
Agent 按插件开发 Skill 直接跑 CLI。

`vibex-plugin install --link` / `dev` / `doctor` 若仍实现，只能作为 `add --dev` 的
同一 Host import 的别名，不得再要求 `VIBEX_PLUGIN_DEV_GRANT`。设置页「插件开发」
对话框不再展示 loopback endpoint 或索要凭据。需要该产品时，从市场官方分类安装
「插件开发」插件。

插件开发 Skill 必须写清完整开发与测试规范：定位本机 `vibex-plugin toolchain`、
确认产品边界、`init`、组装、stdio 入口、harness、`validate`/`test`、`add --dev`、
`test --host`、`pack` 与市场/Git 安装。禁止把校验成功当成 App、Runtime 或 MCP 已在
Host 上可用。禁止向用户索要 token。

### 5. 设置 → 插件增加市场 Tab，安装必须预览并诚实确认

目录页分为两个 Tab：**已安装** 与 **插件市场**。详情页仍只有「内容」和「配置」
（ADR-0047 第 7 点只约束详情页）。已安装 Tab 继续单列已纳入 catalog 的包。

市场 Tab 接入 `https://vibex.xforever.xin/marketplace`。Host 只消费官网提供的
版本化 Catalog API（见第 6 节），不爬 HTML。

列表规则：

- **官方分类**独立拉取，全量展示，不计入社区条数上限。
- 进入市场 Tab 时，默认选中官方分类，并把官方列表置顶。
- **社区列表**默认只拉 50 条（不含官方）。搜索打在完整已发布目录上，不限这 50 条。
- 列表项展示名称、一句话 summary、owner、版本/tag、来源（官方市场或 GitHub）。

安装预览和 Full Trust 确认以**弹窗**完成，适用于：市场安装、拖入 `.vxp`、
`vibex plugin add --profile` / `--web`、离线官方缓存。弹窗至少展示：owner、
plugin-name、tag、version、publisher/id、摘要、将获得的用户可见能力（打开的文件、
注入的 MCP、是否有 Worker/App）、来源 URL 或仓库，以及一句不可省略的确认：

> 安装后该插件以你的本机用户权限运行，不是沙箱。

用户取消则不写入 catalog。没有预览成功不得安装。

### 6. 安装物身份、来源锁与可更新

**产品身份**仍是 ADR-0046 的 Publisher + Plugin ID：同 ID 不同 Publisher 不能继承
权限或数据。

**安装物身份**是四元组 `owner / plugin-name / tag / version`：

| 来源 | owner | plugin-name | tag | version |
| --- | --- | --- | --- | --- |
| 官网市场 | 市场 `authorId` | 市场 `pluginId` | 该次上架的 tag | 包内 semver |
| GitHub（含 CLI `--web` 指向仓库或 Release） | GitHub owner | 仓库名 | git tag / commit | 包内 semver |

同一 Host 对同一产品身份（Publisher + Plugin ID）只保留一份 membership。换
owner 或换 plugin-name 视为不同安装物，冲突时预览弹窗让用户保留或替换。

安装时写下 **来源锁**：`sourceKind` 为 `marketplace` 或 `github`，加上上述四元组、
远端 URL、digest。CLI 从 GitHub 拉取时，`sourceKind=github`，之后 `plugin update`
只向该仓库取新 tag/version，不改写成官网。从市场安装的，更新只问官网 Catalog。
链接开发目录没有市场/GitHub 更新通道，不显示「可更新」。

已安装列表在来源锁仍有效、远端出现更新的 tag 或更大 semver 时显示 **可更新**，
并提供更新动作。更新再次走预览弹窗；digest、publisher 或可执行入口变化时必须
重新确认 Full Trust。更新保留用户 `config.json`，按新 schema 校验。检查更新失败
时保持「可更新」缺失，不得把未知填成已是最新。

### 7. 公共作者契约只包含已闭环的能力

对作者公开的 integration 与 `host.call`，必须同时满足：CLI `validate`、Host
inspect、至少一处真实 UI 或 Agent 消费、以及作者 Skill/参考文档。缺一项就不得
出现在 `init` 模板或「稳定面」叙述里。

当前稳定面：

- `content.skill`、`content.mcp`（包内 managed Runtime 或官方 `hostFamilyBinary`）、
  `content.hook`、`workflow.binding`
- `file.opener` + `artifact.preview`；`file.opener` + `app.surface(slot: artifact.editor)`
- `app.surface` 的 `plugin.detail.panel` 与 `artifact.editor`
- `host.service`

UI 已消费但尚无官方参考包的 `app.command` / `app.toolbar` / `app.status` /
`app.composer.slash` / `app.timeline.card` / `app.settings.section` 可以保留
kind，不进入默认 `init` 模板，Skill 标明「Host 已挂孔、无官方范例」。

明确排除出稳定面：`app.surface.slot = conversation.timeline.card`（与 Host/CLI
不一致）、`dependencies.kind = plugin`（CLI 接受、Host inspect 拒绝）、把
`host.call` 的 `network.fetch` / `files.*` / `secrets.*` / `conversation.*` 写成
可用 API、把 Isolated v5 写成 v4 默认。

### 8. Host 旅程是模板与官方包的完成门

官方包和带 Worker/App/MCP 的 `init` 模板，在 harness 之外必须通过最短 Host 旅程：
链接或安装 → 启用 → 行使该模板声明的用户可见能力 → 卸载或禁用后开发目录仍在。
产品命令是 `vibex plugin test --host`。没有这条旅程，不得声称模板或官方包完成。

## Marketplace Catalog API

产品官网（`~/Projects/vibex-site`）为 Host 增加只读 Catalog API，与现有提交/审核
队列分离。现有 `GET /api/marketplace/list` 返回全量已发布数组，缺少官方/社区分页、
搜索和 tag。Host 不依赖该无版本端点作为权威。

Host 消费的最低契约（路径可落在 `/api/marketplace/v1/`）：

1. `GET official` — 全量 `category=official` 且已发布的条目。
2. `GET community?limit=50&offset=0` — 已发布且非官方，默认 50。
3. `GET search?q=` — 在全部已发布条目中搜索，包含官方。
4. `GET listing/{owner}/{plugin}` — 单条详情，含 summary、版本、tag、来源、
   digest、下载描述。
5. `GET listing/{owner}/{plugin}/versions` — 该 owner/plugin-name 的 tag/version
   列表，供「可更新」比较。
6. `GET artifact/{owner}/{plugin}?tag=&version=` — 与现有 artifact 兼容的下载描述：
   `downloadUrl`、`sourceKind`、`sha256`、四元组。

条目至少包含：owner、plugin-name、tag、version、displayName、summary、category、
sourceKind（`official` 显示用分类 vs 包来源 `github`/`upload`）、homepage 或
repo URL、package digest。未发布、待审、已拒绝的条目不得出现。

官网继续按 ADR-0005：提交可匿名，上架必须待审。Host 市场 Tab 只读已发布目录。

## Relationship to prior ADRs

- **修订 ADR-0047** 目录页信息架构：增加「已安装 / 插件市场」两个目录 Tab；详情页
  仍只有内容与配置。
- **修订 ADR-0048** 的产品后果：市场与 `.vxp` 安装必须弹出 Full Trust 确认，这不是
  capability grant，而是安装信任决定的可见化。
- **修订 ADR-0055 / ADR-0057**：官方 MCP 二进制仍随 Host；官方**插件包**不再 builtin
  预装、不再禁止卸载。
- **不修订** ADR-0046 的 Publisher+ID 产品身份、候选代、digest；不修订 ADR-0051 的
  托管 MCP 通用 seam。
- 产品官网 ADR-0005 仍然有效；本决定要求它补 Host 用的 Catalog API，不把待审包
  暴露给 VibeX。

## Consequences

- 新 Host 打开插件页时 catalog 可以为空，官方能力需从市场安装。这是有意选择。
- 会话增强、`&` 委派、Office 预览、Workflow 插件编辑面、插件开发 Skill 都变成
  「先安装再启用再新开会话」。
- 作者只记一套 CLI。插件开发包变瘦：Skill + 参考，不再带开发 MCP。
- `init` 与官方参考包形状对齐后，Agent 按 Skill 生成的包才能在 Host 上活。
- 已安装列表出现「可更新」要求 Host 持久来源锁，并定期或在打开插件页时询问官网
  或 GitHub。离线时保持上次观察，不把未知显示成已最新。
- Companion 仍不能写插件（ADR-0054）。市场浏览若走 Remote，只作为 Host 上的安装
  请求，不在手机上执行 Worker。

## Considered options

- **首次推荐批量启用官方插件。** 否决。官方包改为市场安装，不在空 catalog 上推销
  一组默认开关。
- **保留开发 MCP 作为 Agent 调试面。** 否决。当前实现不能签发 grant；Agent 跑 CLI
  更短。半截工具会造成编造 token。
- **继续 builtin 预装但允许卸载。** 否决。预装仍会让「未选择」和「已安装未启用」
  混在同一列表。官方分类置顶已经承担发现职责。
- **安装不弹 Full Trust 确认（纯 ADR-0048）。** 否决。市场出现后，用户必须看见
  「以本机权限运行」才能完成安装。这不是逐 capability 审批。
