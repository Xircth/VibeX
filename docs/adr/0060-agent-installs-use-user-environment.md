---
status: accepted
date: 2026-08-18
decision-makers:
  - VibeX maintainers
supersedes: 0011
---

# Agent 安装只写入并绑定用户环境

VibeX 不再为 Agent 维护独立的托管产物树。本地 Runtime 与 ACP 的唯一真相源是用户环境：PATH、npm 全局前缀、uv tools 与用户 bin。

平台上的「安装 Runtime / ACP」必须把官方分发写进该环境（`npm install -g --prefix <可写 npm prefix>`、`uv tool install`、Binary 写入 `~/.local/bin`），再按 PATH 探测并记录 Installation lock。锁是对用户环境的观察，不是另一份安装物。live `npm prefix -g` 仅在当前用户可写时使用；macOS 上常见的 `/usr/local` 不可写，则写入 `~/.local`。安装仍遇到 EACCES 时重试用户前缀，不要求 sudo。适配器型 Agent 按组件写入：PATH 上已有的 vendor CLI（`agent_runtime`）直接复用；ACP 在显式安装或更新时按计划版本写入。安装目标优先解析 npm `dist-tags.latest`（Runtime 与 ACP 各自解析）；用户可指定具体版本，CLI 与 ACP 不匹配只提示风险，不阻止安装。

系统缺少兼容的 Node、npm 或 uv 时，安装器可以使用固定版本的引导工具链来执行上述用户环境写入，但不得把引导工具链记为 Agent 安装物，也不得再发布 Agent 私有 shim。共享工具链不属于 Agent 安装物。

启动时必须先修复 GUI 进程 PATH（用户/系统 Path、nvm-windows、fnm、Volta、Scoop、mise、用户 npm prefix），再探测。自动绑定只要求 ACP（或 combined）组件在 PATH 上可解析且版本非空；不要求达到 Profile 钉，也不要求 ACP `initialize` 握手成功。会话启动优先使用 PATH 上的同名命令，再回退 Installation lock 路径。握手是会话启动时的健康检查，失败不得撤销已经写入用户环境的 CLI，也不得把 Installation lock 当成未安装。npm `.cmd` shim 的内容指纹变化不是完整性损坏。用户在终端自行升级后，下次检查重绑路径与版本。

显式安装或修复不得因为 PATH 上已有更旧或残缺的 ACP 命令而直接成功；必须按锁定或指定版本写入 ACP。vendor CLI 只要 PATH 可解析即可复用。安装不再因同名用户命令发布 shim 失败。

卸载按分发方式移除该 Agent 在用户环境中的 CLI 包；卸载后 PATH 上命令仍在则失败并保留锁。移除仍只取消非内置 Agent 的纳入关系，但会先走同一套用户环境卸载。

本决策取代 ADR-0011。插件 Runtime 与 GitHub CLI 安装器不在本决策范围内。
