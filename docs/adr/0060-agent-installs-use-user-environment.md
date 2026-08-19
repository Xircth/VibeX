---
status: accepted
date: 2026-08-18
decision-makers:
  - VibeX maintainers
supersedes: 0011
---

# Agent 安装只写入并绑定用户环境

VibeX 不再为 Agent 维护独立的托管产物树。本地 Runtime 与 ACP 的唯一真相源是用户环境：PATH、npm 全局前缀、uv tools 与用户 bin。

平台上的「安装 Runtime / ACP」必须把官方分发写进该环境（`npm install -g`、`uv tool install`、Binary 写入 `~/.local/bin`），再按 PATH 探测并记录 Installation lock。锁是对用户环境的观察，不是另一份安装物。

系统缺少 Node、npm 或 uv 时，安装失败并提示用户先安装本机工具链。VibeX 不得下载或回退到托管 Node / uv。共享工具链不属于 Agent 安装物，安装与卸载都不得修改它们。

启动只检查锁中记录的用户环境可执行文件是否仍存在。用户在终端自行升级后，下次检查重绑路径与版本，不把内容指纹变化当成托管完整性损坏。

卸载按分发方式移除该 Agent 在用户环境中的 CLI 包；卸载后 PATH 上命令仍在则失败并保留锁。移除仍只取消非内置 Agent 的纳入关系，但会先走同一套用户环境卸载。

本决策取代 ADR-0011。插件 Runtime 与 GitHub CLI 安装器不在本决策范围内。
