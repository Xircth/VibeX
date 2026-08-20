---
status: accepted
date: 2026-08-18
decision-makers:
  - VibeX maintainers
supersedes: 0011
---

# Agent 安装只写入并绑定用户环境

VibeX 不再为 Agent 维护独立的托管产物树。本地 Runtime 与 ACP 的唯一真相源是用户环境：PATH、npm 全局前缀、uv tools 与用户 bin。

平台上的「安装 Runtime / ACP」必须把官方分发写进该环境（`npm install -g --prefix <user prefix>`、`uv tool install`、Binary 写入 `~/.local/bin`），再按 PATH 探测并记录 Installation lock。锁是对用户环境的观察，不是另一份安装物。适配器型 Agent 按组件写入：已满足锁定版本的组件复用，只安装缺失或过旧的那一个。

系统缺少兼容的 Node、npm 或 uv 时，安装器可以使用固定版本的引导工具链来执行上述用户环境写入，但不得把引导工具链记为 Agent 安装物，也不得再发布 Agent 私有 shim。共享工具链不属于 Agent 安装物。

启动与清除应用数据后的探测只在「所需组件齐全、ACP 握手成功、且每个组件版本不低于 Built-in Profile / 冻结计划钉」时自动绑定。更旧或残缺的残留 CLI 保持未安装，由用户安装/修复写入锁定版本。用户在终端自行升级到更新版本后，下次检查重绑路径与版本，不把内容指纹变化当成完整性损坏。

显式安装或修复不得因为 PATH 上已有更旧或残缺的同名命令而直接成功；必须按锁定版本写入用户环境。安装不再因同名用户命令发布 shim 失败。

卸载按分发方式移除该 Agent 在用户环境中的 CLI 包；卸载后 PATH 上命令仍在则失败并保留锁。移除仍只取消非内置 Agent 的纳入关系，但会先走同一套用户环境卸载。

本决策取代 ADR-0011。插件 Runtime 与 GitHub CLI 安装器不在本决策范围内。
