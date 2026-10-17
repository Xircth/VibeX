---
status: accepted
date: 2026-10-07
---

# OMP 作为原生 ACP 内置 Agent 接入

OMP（`@oh-my-pi/pi-coding-agent`）自带 ACP server：`omp acp` 在 stdio 上说话。它不是 Pi 的第二套适配器，也不走 `pi-acp`。

## Decision

- `AgentKind::Omp`（`"omp"`）是永久内置成员。`oh-my-pi` 读入时归一到同一身份。
- 拓扑是 `NativeAcp`。安装钉 `@oh-my-pi/pi-coding-agent@18.8.0`，启动参数只有 `acp`。检测名是 `omp`。
- 发布物的 shebang 是 Bun。预检查要求 `bun >= 1.3.14`。Node/npm 只负责把包写进用户环境。
- 登录动作是 `omp login`。设置面有官方订阅和供应商。密钥不走环境变量。活凭据在 `~/.omp/agent/agent.db` 的 `auth_credentials`，自定义端点的 `apiKey` 在 `models.yml`。空的 `auth.json` 不是未登录。有 oauth 记为账号，只有 api key 记为密钥。两者都没有时预检查失败。
- 绑定供应商时写入 `models.yml` 的 `providers`，并把 `config.yml` 的 `modelRoles.default` 设为 `供应商/模型`。其它角色、主题和已有供应商保留。原生配置还可改深色主题和自动压缩。OMP 没有单一官方 API 端点，所以不出现官方 API 密钥框。
- ACP 会话不发现磁盘 MCP，实际生效的是 `session/new.mcpServers`。设置里勾选 OMP 时，分配写入 `~/.omp/agent/mcp.json`（不进 Pi 的目录），并在新建或恢复会话时注入。仍不把 Pi 的 `PI_ACP_*` 传给子进程。
- 启动时把子进程的 `PI_CODING_AGENT_DIR` 钉到 VibeX 写入的同一目录。未单独指定时是 `~/.omp/agent`。进程环境里指向 `~/.pi/agent` 的值不采用，避免把 OMP 的配置写进 Pi，或把 Pi 的目录覆盖进 OMP。
- Skills 写到 `~/.omp/agent/skills`（`PI_CODING_AGENT_DIR` 可覆盖）。项目侧是 `.agents/skills`。
- 历史在 `~/.omp/agent/sessions/<编码工作区>/*.jsonl`。记录形状与 Pi 的 `session` / `message` 相同，标题来自第一条 `title` 记录。

`registry_id = "omp"` 不是官方 Registry 条目。它只保证以后同名 Registry 条目绑到这个档案，而不是再造一个 Agent。
