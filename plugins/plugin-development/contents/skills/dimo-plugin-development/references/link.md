# 链接运行中的 Host

安装或链接即 Full Trust。Worker、App 与声明的 Runtime 使用与 Host 相同的本机权限。独立进程和 App frame 管热更新、崩溃和 dispose。安装确认句：

> 安装后该插件以你的本机用户权限运行，不是沙箱。

Host 保留开发目录。卸载链接只去掉 Dimo 一侧引用，永不删除该目录。源内容变化后重新校验身份、贡献和配置；候选代失败则上一完整代仍对外可见。

## 产品 CLI

本机已安装 `dimo`，且 Desktop 或 `dimo serve` 在跑：

```text
dimo plugin run server --http://127.0.0.1:17891 --token <token>
dimo plugin add --dev . -y
dimo plugin run dev
```

`run server` 把 URL 和 token 写入 `~/.dimo/pluginrc`。之后在插件目录里 `run …` 即可。向用户或对话省略 token。

`add --dev`（`npx dimo plugin`）行为：

1. `build`（失败只警告）。
2. `validate`，失败则停止。
3. 用本机 Host token（`DIMO_TOKEN`、`~/.dimo/pluginrc` 或数据目录里的 `host.token`）调用 `plugin_control_import`，`developerLink: true`。
4. 尝试 `plugin_control_set_enabled`。
5. 未加 `--detach` 时把该插件 Worker stderr 打到当前终端。`--detach` 则链接后返回。

`run dev` 再 build、监视源码；digest 变化后发布候选代。有 Federation remote 时启动 Vite，Host `loadRemote` 指向该端点。chrome 槽位随激活代刷新。

Host 未运行时，路径写入 `~/.dimo/imports/links.jsonl`，下次启动再导入。

其它产品命令：

```text
dimo plugin pack [dir] [--output file.vxp]
dimo plugin add --profile file.vxp -y
dimo plugin add --web <git>#tag -y
dimo plugin add --web https://dimo-ai.com/marketplace/<owner>/<name> -y
dimo plugin list
dimo plugin update <id>
dimo plugin remove <id>
dimo plugin test --host [dir]
dimo plugin publish
```

`test --host` 会链接、启用、断言声明的 chrome / 结构面 kind 出现后在禁用时撤下、改一份 Skill（若有）、等待 digest 更新、再卸载；开发目录必须还在。

没有 `dimo plugin toolchain`。查 SDK/CLI 路径用 `dimo-plugin toolchain`。

`dimo-plugin install --link` / `dev` 若仍实现，只能作为同一 Host import 的别名。优先使用 `add --dev` 加 `run dev`。

## 来源锁与发布

市场安装记下 `sourceKind=marketplace`，更新问官网 Catalog `versions`。GitHub `--web` 记下 `sourceKind=github`，更新问该仓库的 tag。链接开发没有远端更新通道，不显示「可更新」。

用户明确要求上架：

```text
dimo plugin publish . --owner <市场用户名> --password <密码> [--show-tree]
dimo plugin publish --web <github-owner/repo[#tag]> --owner <市场用户名> --password <密码>
```

凭据也可用 `DIMO_MARKET_OWNER` / `DIMO_MARKET_PASSWORD`。GitHub owner 必须与市场用户名相同。待审包不会出现在 Catalog。
