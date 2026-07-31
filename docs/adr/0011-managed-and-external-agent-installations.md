---
status: accepted
date: 2026-07-28
decision-makers:
  - VibeX maintainers
---

# Agent 安装采用托管与外部两种所有权

VibeX 将每个 Agent 安装明确记录为托管安装或外部安装。通用 Registry
Agent 及独立 ACP 适配器由 VibeX 安装和管理，不再修改全局包，也不在每次启动时
临时下载执行；内置 Agent 的本地 Agent runtime 可以采用经绝对路径和兼容性校验的
现有系统安装，也可以由用户选择交给 VibeX 托管安装。

托管安装成功后，VibeX 将本地 Agent Runtime 的主命令发布为用户级稳定入口：
Unix 使用 `~/.local/bin`，Windows 使用同一用户目录并写入 User PATH。入口只是一层
由 VibeX 标记所有权的 shim，实际制品仍保留在版本锁定的 Agent 私有目录；更新和
回滚原子切换 shim 指向，卸载和移除只删除对应 Agent 拥有的 shim。若同名命令已由
用户或其他 Agent 所有，安装必须明确失败，不能覆盖。ACP 适配器不是本地 Runtime
主命令时不得单独发布到终端。应用启动时必须对已有托管安装执行同样的发布与校验，
使该能力不依赖用户打开设置页面；发布失败的安装进入需修复状态并保留诊断记录。

Node、uv、Python 等基础运行环境可以复用兼容的系统环境，也可以使用 VibeX
维护的版本化共享运行环境。对于适配器型内置 Agent，ACP 适配器始终是托管安装，
并绑定到已经校验的确切 Agent runtime 路径。

因此，升级、修复和卸载只能修改 VibeX 托管的产物；外部安装只能被使用和重新
校验，不能由 VibeX 修改或删除。未来实现需要用作用域内、可审计的安装取代当前
全局 npm 安装策略，并在持久化安装记录中保存所有权。

四个 Built-in Agent 在设置页打开时主动探测其官方本地 Runtime。只有候选绝对路径、
版本、完整性与 ACP 握手均通过，VibeX 才自动将其接入为外部安装；探测过程不下载、
不修改、也不删除用户已有 CLI。任一验证未通过只展示诊断并提供安装或修复入口，
不得自动绑定。
