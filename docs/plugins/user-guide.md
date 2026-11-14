# VibeX 插件指南

本文对照当前 Host（`v0.4.x`）以及 [ADR-0066](../adr/0066-plugin-marketplace-authoring-and-session-honesty.md) / [ADR-0069](../adr/0069-everything-is-a-plugin-platform.md) 的产品行为。插件发现与管理入口位于「设置 → 插件」的「已安装 / 插件市场」两个 Tab。

## 它是什么

插件是一份可以安装、启停、配置的产品功能。列表里你看到的是名字、一句话简介、发布者、版本和开关。点进去只有两个主 Tab，内容和配置。

内部可能带着 Skill、MCP、Workflow、文件预览、编辑页或后台 Worker。那些是接线，不是给你分类用的。Office 在目录里就是 Office，不会拆成「文档 Skill」和「预览扩展」两套产品。

VibeX 自己的会话日志、Agent 连接、工作区隔离和窗口布局仍由 Host 负责。插件往这些面上挂能力，不替代它们。

官方包在市场官方分类里，不随 Host 预装进 catalog。磁盘上有官方 MCP 二进制，不等于已经安装插件，更不等于已经注入 Agent。在设置里确认 Full Trust 后，插件会立即启用；能力仍在新建会话后生效，已有会话不会热挂。`vibex plugin add --web` / `--profile` 仍默认禁用。

## 从哪里打开

桌面应用里打开 `/plugins`。目录页有「已安装」和「插件市场」。点一条进入 `/plugins/<插件ID>`，详情只有内容和配置。

远程客户端连到同一 Host 时，改的是那台机器上的插件环境，不会在你笔记本上再跑一份。

Agent 自己的原生插件（Codex、Claude Code 那一套）仍在「设置 → Agent → 对应 Agent」底部管理，不进这个产品目录。

## 有什么用

启用之后，能力会从当前激活代进到界面和 Agent。常见结果如下。

打开 `.docx` / `.xlsx` / `.pptx` 走 Office 预览。Composer 里出现插件斜杠或 Workflow。工具栏、状态栏、命令面板、时间线卡片、设置段可以多出插件提供的入口。兼容的 Agent 会看到投影过去的 Skill。带官方 MCP 的包会在之后新开或重新绑定的会话里注入工具。

关掉插件，这些入口应从当前代里消失。已经开着的 Agent 会话通常不会热拆 STDIO MCP，新会话才干净。

## 怎么安装

设置里确认 Full Trust 后立即启用。`vibex plugin add --web` / `--profile` 仍默认禁用，避免无确认的 CLI 直接进 Agent。

### `vibex plugin add`

本机已安装 Desktop 或 `vibex-server` 时，CLI 会发现 Host 并写入同一套控制面。Host 没在跑时，发布包进入 `~/.vibex/imports`，链接开发目录进入 `~/.vibex/imports/links.jsonl`，下次启动再导入。

```bash
vibex plugin add --web https://github.com/Xircth/vibex-plugin-office#v1.0.0 -y
vibex plugin add --web github:Xircth/vibex-plugin-office#v1.0.0 -y
vibex plugin add --profile ~/plugins/search.vxp
vibex plugin add --dev ~/Projects/office
vibex plugin list
vibex plugin update acme.search --ref v1.3.0
vibex plugin remove acme.search
vibex plugin remove acme.search --delete-data
vibex plugin gc-runtimes
```

`--web` 接受 Git 仓库、GitHub、市场 URL 或归档 URL。`#tag`、`#branch`、`#commit` 钉住所装 tree，不再跟随默认分支。`--profile` 接受本地 `.vxp` / `.zip`。`--dev` 把目录链到 Host；源码变化后 Host 重新发布候选代，CLI 默认停在前台监视并在需要时 rebuild。`--detach` 只链接，由 Host 继续监视。

`list` 与设置里的插件目录是同一份 Host catalog。`remove` 卸非内置包；默认保留用户配置，`--delete-data` 才删 Host 管理的 snapshot。链接开发目录不会被删除。

### 拖入或选择 `.vxp`

桌面且具备 `plugin.write` 时，目录页可以「添加插件」，也可以把 `.vxp` 拖到页面上。只接受带 `.vibex-plugin/plugin.json` 并且通过校验的包。

同 ID 已经存在时，界面会停下来让你保留当前源或替换。同一身份不能同时挂两份源。

### 插件市场

市场 Tab 默认置顶官方分类，下面是社区 50 条。搜索打在全部已发布条目上。安装前会弹出身份、能力和 Full Trust 确认：

> 安装后该插件以你的本机用户权限运行，不是沙箱。

取消则不写入 catalog。已安装且来源锁定的包，远端出现更新 tag 或更大 semver 时显示「可更新」。市场安装的包问官网，GitHub 安装的包问该仓库。

离线时官方分类仍可用发行物里的快照缓存，安装路径与在线相同。

### 更新插件

Host 启动约 30 秒后检查一次，之后每 6 小时检查。发现新版本时，状态栏显示更新数量，
并提供通知入口。也可以在插件目录点「检查更新」。检测失败会显示错误并保留上次观察，
不会把离线状态显示为已是最新。

点「可更新」后，Host 先下载并校验候选包，展示发布者、插件身份、版本、来源、能力、
包摘要和更新说明；确认后才切换。确认有效期为 10 分钟，期间修改配置或启用状态需要
重新预览。取消不会升级。第一批只自动检测，安装始终需要确认。

CLI 使用同一条 Host 更新路径：

```bash
vibex plugin update acme.search
vibex plugin update acme.search --ref v1.3.0 --yes
```

无 `--ref` 时选择更大的稳定 semver 版本；GitHub 支持 Release 包和稳定 tag 的源码归档，
不自动跟随分支或任意 commit。非交互环境必须传 `--yes`。来源始终跟随安装时的锁，
GitHub 插件不会改从市场更新。开发链接和没有远端来源的本地包不参与检测。

更新保留配置、启用状态和已有 Agent 绑定；新 schema 无法接受原配置时拒绝升级。
候选校验或启动失败时保留原版本文件和运行代，无需卸载重装。

### 开发者链接目录

`vibex plugin add --dev` 与 `vibex-plugin install --link` 都把同一份源目录登记为 linked development。VibeX 跟着那个目录走，不会删你的源码。

## 怎么启用

市场 / 本机安装后开关已打开；也可在已安装列表里再关掉。

带 Skill 的包，首次启用默认向当前已安装、支持 Skill 的 Agent 做投影，并给以后新装的 Agent 留意图。带 MCP 的包同样默认面向兼容 Agent。你可以再到 MCP 设置里改个别 Agent。

官方 MCP 只影响启用之后新开或重新绑定的会话。旧会话工具清单可能还在，直到那次会话结束。

本地 Runtime 依赖尚未就绪时无法发布激活代（自 `v0.4.4` 起 Host 会在安装/启用时自动解析并安装声明的本地 Runtime，例如 Office 所需的 `officecli` 必须锁住并通过探测）。插件之间彼此独立，不存在插件依赖插件。

打开后看两件事：内容 Tab 核对 `README.md` 与 `contents/`，配置 Tab 按清单里的 Schema 原子编辑并写回包根上的 `config.json`。更新插件时默认保留你修改过的配置。

## 怎么用

按产品用，不要按内部种类用。

- **Office** 启用后，在工作区直接点击 `.docx` / `.xlsx` / `.pptx` 预览，或在对话里通过 Workflow / Skill 生成、修改与分析文档。
- **会话增强** 启用后，之后新建或重绑定的会话里 Agent 可以向你提问、读取实时纠偏备注、查询 `@会话` 引用以及受控编排子会话；配置页提供四个独立开关。
- **Workflow Creator** 启用后，打开 `*.vibex-workflow.json` 即进入可视化编辑页，也可让 Agent 调用其 Skill 与 `vibex-workflow-mcp`；显式发布才会生成不可变版本。
- **插件开发** 启用后，自动向兼容 Agent 投影 `vibex-plugin-development` Skill，配合本机 `vibex-plugin` CLI 完成初始化、校验、构建与 `--dev` 链接。
- 注意：**协作空间**与 `&Agent` 委派现为宿主内置能力（位于「设置 → 常规 → 协作空间」，默认开启），无需安装插件。

## 怎么关掉

把开关拨回去即可。

Host 会按反序原子拆除这一代对外的投影：停止后台 `host.service`、结束 Worker、撤回 UI / Provider 贡献目录，并从后续新会话的 MCP / Skill 清单中移除该插件。

关掉不等于卸载。包还在 catalog 里，配置文件也还在。

## 怎么卸载

详情里选卸载，或：

```bash
vibex plugin remove <插件ID>
vibex plugin remove <插件ID> --delete-data
```

确认后会去掉 membership、Agent 绑定、Skill 投影和相关信任。全局 Runtime 字节、产物、会话和自动化历史会留着。默认留下用户 `config.json`；`--delete-data` 删除 Host 管理的 snapshot。

随 Host 带来的官方包不要按第三方包那样卸掉。目录里它们标成随 Host 安装。你能禁用，不能当普通快照删掉。

链接开发插件卸的是 VibeX 这一侧的引用。你的开发目录还在。

卸载时可以选是否保留 `config.json` 这类用户数据。默认倾向保留，除非你明确要删。

## 常见卡住的地方

开了官方 MCP，当前对话没有新工具。先结束会话或重新绑定 Agent，再开新会话。

Office 打不开。看 Runtime 是否锁住、探测是否通过。预览进程有空闲超时，默认 10 分钟。

两个同 ID 包抢身份。只能留一份源，选保留或替换。

依赖的插件被你关了。当前这个包可能仍显示想启用，但贡献已经不在目录里。先把依赖打开。

远程客户端改插件，改的是 Host，不是你本机再装一份。
