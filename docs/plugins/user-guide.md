# VibeX 插件指南

我对照的是当前 Host（0.1.3）和 ADR-0066 落地后的产品行为。发现与安装走设置 → 插件的「已安装 / 插件市场」两个 Tab。

## 它是什么

插件是一份可以安装、启停、配置的产品功能。列表里你看到的是名字、一句话简介、发布者、版本和开关。点进去只有两个主 Tab，内容和配置。

内部可能带着 Skill、MCP、Workflow、文件预览、编辑页或后台 Worker。那些是接线，不是给你分类用的。Office 在目录里就是 Office，不会拆成「文档 Skill」和「预览扩展」两套产品。

VibeX 自己的会话日志、Agent 连接、工作区隔离和窗口布局仍由 Host 负责。插件往这些面上挂能力，不替代它们。

官方包在市场官方分类里，不随 Host 预装进 catalog。磁盘上有官方 MCP 二进制，不等于已经安装插件，更不等于已经注入 Agent。新安装默认禁用。插件能力在新建会话后才生效，已有会话不会热挂。

## 从哪里打开

桌面应用里打开 `/plugins`。目录页有「已安装」和「插件市场」。点一条进入 `/plugins/<插件ID>`，详情只有内容和配置。

远程客户端连到同一 Host 时，改的是那台机器上的插件环境，不会在你笔记本上再跑一份。

Agent 自己的原生插件（Codex、Claude Code 那一套）仍在「设置 → Agent → 对应 Agent」底部管理，不进这个产品目录。

## 有什么用

启用之后，能力会从当前激活代进到界面和 Agent。常见结果如下。

打开 `.docx` / `.xlsx` / `.pptx` 走 Office 预览。Composer 里出现插件斜杠或 Workflow。工具栏、状态栏、命令面板、时间线卡片、设置段可以多出插件提供的入口。兼容的 Agent 会看到投影过去的 Skill。带官方 MCP 的包会在之后新开或重新绑定的会话里注入工具。

关掉插件，这些入口应从当前代里消失。已经开着的 Agent 会话通常不会热拆 STDIO MCP，新会话才干净。

## 怎么安装

新装进来默认禁用。先装后开，避免半成品直接进 Agent。

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

### 开发者链接目录

`vibex plugin add --dev` 与 `vibex-plugin install --link` 都把同一份源目录登记为 linked development。VibeX 跟着那个目录走，不会删你的源码。

## 怎么启用

打开详情页上的开关。

带 Skill 的包，首次启用默认向当前已安装、支持 Skill 的 Agent 做投影，并给以后新装的 Agent 留意图。带 MCP 的包同样默认面向兼容 Agent。你可以再到 MCP 设置里改个别 Agent。

官方 MCP 只影响启用之后新开或重新绑定的会话。旧会话工具清单可能还在，直到那次会话结束。

依赖没装好或没就绪时，开不开。例如 Office 需要 `officecli` 这套 Runtime 锁住并能探测通过。插件 A 声明必须依赖插件 B 时，B 必须已经启用并且自己也有活着的激活代。

打开后看两件事。内容 Tab 里 README 和 `contents/` 对不对。配置 Tab 改的是包根上的 `config.json`，保存前按清单里的 schema 校验，原子写回。更新插件时默认留你改过的配置。

## 怎么用

按产品用，不要按内部种类用。

Office 启用后，在工作区点文档，或在对话里说要生成、修改、分析哪一类文件。Composer 里选中的是 Workflow 身份，不是另一套「动作」概念。

会话增强启用后，之后的新会话里 Agent 可以提问、读你的中途备注、查询你点名的会话、控制本会话或子会话。四个开关在配置页，关掉哪一项，哪一项就不进工具清单。

多智能体协同启用后，输入框可以用 `&` 点名其它 Agent。点名本身不会启动子任务，父模型调用委派工具才会。关掉插件，`&` 马上消失。已经注入的会话里工具名可能还在，新的委派会被拒绝。

Workflow Creator 启用后，可以打开 `*.vibex-workflow.json` 进编辑页，也可以让 Agent 走它的 Skill 和 MCP。源文件仍是创作真相。发布才会生成不可变版本。Automation 钉在某个已发布版本上，不会跟着草稿走。

插件开发包启用后，Skill 默认投影给已安装 Agent。开发用的 MCP 默认关着。打开它以后，链接本机插件仍要你确认。

## 怎么关掉

把开关拨回去。

Host 会按反序拆这一代对外的投影。停后台 `host.service`，结束 Worker，收回贡献目录，官方 MCP 只从仍有活代的包收集。依赖这个包才就绪的其它插件会退出就绪，但它们的启用意图可以还在。你把依赖再打开，它们会尝试重新挂上。

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
