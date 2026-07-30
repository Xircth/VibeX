---
status: accepted
date: 2026-07-28
decision-makers:
  - VibeX maintainers
---

# Agent 安装精确锁定版本并由用户确认升级

每次托管安装都记录 Agent Runtime、ACP 适配器和基础 Runtime 的确切版本与来源，
启动时不解析 `latest`。普通 Registry Agent 首次安装时锁定用户确认时 Registry
提供的具体版本；内置 Agent 只能安装 Built-in Agent Profile 中已经验证的版本组合。

Registry 刷新只产生更新提示，不自动升级。更新安装到独立版本位置，通过完整预检
和 ACP 握手后才切换为当前版本；失败时继续使用旧版本。外部 Runtime 的升级由其
所有者负责，VibeX 发现版本变化后只重新校验，不主动修改。

“有可用更新”不是故障状态：导航带继续显示当前安装的健康与就绪徽标，详情页的
运行环境区域显示版本差异与手动更新入口。只有当前安装本身失效时才进入需要修复状态。

更新尝试被取消、失败或因应用退出而中断时同样不改变当前 Installation lock；
已经验证的旧版本继续可用，未完成的新版本只作为暂存产物被协调或清理。所有中断
的安装尝试都等待用户明确重试，不在启动恢复期间自动续跑。
