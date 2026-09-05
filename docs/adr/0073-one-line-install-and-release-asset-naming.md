---
status: proposed
date: 2026-09-04
decision-makers:
  - VibeX maintainers
---

# 一行安装：发布资产命名单一来源，install.sh / install.ps1 与 npx 共用解析

本 ADR 交付 `install.sh` 与 `install.ps1`，并修掉它们暴露出的根因——发布资产名
在三个地方各写了一遍，其中 npx 那一份与 CI 实际产出对不上。

范围只有 **Host Family**（`vibex-server` / `vibex-mcp` / `vibex-workflow-mcp` +
`web/`）。桌面应用继续走 Tauri 安装包与自动更新，不由脚本安装。

## Context

今天有三条获取 Host Family 的路径，各自持有一份资产名：

| 路径 | 资产名 | 出处 |
|---|---|---|
| CI 发布 | `VibeX-${VERSION}-${release_name}-server.tar.gz` | `.github/workflows/host-family-release.yml` |
| npx | `vibex-host-family-${platform}.tar.gz` | `npx-cli/` |
| 文档 | 同 npx | `docs/deployment/headless-server.md`、README |

两套命名的平台段也不同：CI 用 `linux-x86_64` / `darwin-aarch64`，npx 用
`linux-x64` / `macos-arm64`。**没有任何一方从另一方推导**，所以
`npx vibex` 拼出的下载 URL 在 GitHub Release 上不存在。这不是安装脚本缺失导致
的问题，是安装脚本会第四次复制的那个问题。

npx 那条路径里唯一值得保留的是它的校验强度，它做了两级：先用同名 `.sha256`
校验压缩包摘要，解包后再按包内 `SHA256SUMS` 逐文件校验。`scripts/package-host-family.js`
生成的正是这份 `SHA256SUMS`。新脚本必须达到同一强度，而不是「下载即解包」。

`scripts/` 下现有 50 多个脚本，全部服务于开发、打包、签名与冒烟，
`download-and-extract.js` 之类是**开发依赖**下载器，不是给终端用户的安装器。

## Decision drivers

1. 一个资产名只在一个地方定义，其余全部推导。
2. 安装器的校验强度不低于现有 npx 路径。
3. 安装器只装 Host Family，不碰 Agent、不碰桌面应用。

## Decision

### 1. 资产命名由一个模块定义，CI 与所有客户端都从它推导

新增单一命名模块，输入是版本与平台三元组，输出是压缩包名、摘要文件名与
平台目录名。`host-family-release.yml`、`npx-cli`、`install.sh`、`install.ps1`
与部署文档全部引用它，不再各自拼串。

命名与平台段取**CI 现有的那一套**（`VibeX-${VERSION}-${release_name}-server.tar.gz`，
平台段 `linux-x86_64` / `darwin-aarch64` 形态），因为已发布的 Release 资产按它
命名，改 CI 会让历史版本不可安装。改的是 npx 与文档。

`npx-cli` 的平台推导（`linux-x64` / `macos-arm64`）随之作废；它对外的缓存目录
布局 `~/.vibex/host-family/${tag}/${platform}/family/` 可以保留，但 `${platform}`
取值统一到新命名模块。

### 2. install.sh / install.ps1 的职责边界

脚本按顺序做且只做这些：

1. 探测 OS 与 CPU 架构，映射为平台三元组；不支持的组合直接失败并列出支持列表。
2. 解析目标版本：默认最新 Release，可用 `VIBEX_VERSION` 固定。
3. 下载压缩包与 `.sha256`，校验压缩包摘要。
4. 解包后按包内 `SHA256SUMS` 逐文件校验。任一不匹配即中止并清理临时目录。
5. 安装到 `~/.vibex/host-family/${tag}/${platform}/family/`，与 npx 共用同一
   缓存布局，使两条路径互为命中而不是各下一份。
6. 在用户可执行目录放置 `vibex` 启动器，并打印如何加入 `PATH`。

脚本**不**做：不装 Agent（ADR-0060：Agent 装在用户环境里，由用户或 Agent 管理页
负责）、不装桌面应用、不写系统级目录、不要求 root、不注册开机自启。

### 3. 校验失败是终止条件，没有跳过开关

不提供 `--skip-verify` 之类的参数。摘要对不上意味着拿到的不是发布产物，继续
安装只会把问题推到运行期。

### 4. 运行参数沿用既有环境变量，脚本不发明新的

`VIBEX_STATIC_ROOT`、`VIBEX_DATA_DIR`、`VIBEX_SERVER_LISTEN`、
`VIBEX_SERVER_ALLOW_LAN`、`VIBEX_SERVER_TOKEN`、`VIBEX_SERVER_ALLOWED_ORIGINS`
已由 `crates/server` 与 `crates/utils` 读取，默认端口 17891。脚本只负责让
`vibex-server` 可执行，环境变量的语义与默认值不在脚本里第二次定义。

默认监听保持回环。`install.sh` 不得默认打开 `VIBEX_SERVER_ALLOW_LAN`。

### 5. 安装路径进冒烟

`scripts/` 已有 `smoke-vibex-server-package.js`。新增一条冒烟覆盖
「按命名模块拼名 → 下载 → 两级校验 → 启动 → 探活」，在 Release 工作流里对
刚上传的资产跑。命名不一致这类缺陷只有端到端跑一次才会暴露，单测拦不住。

## Consequences

- `npx-cli` 与部署文档里的资产名是**要改的**，改完历史 npx 版本仍指向旧名，
  因此命名模块的引入需要配一个 npx 补丁版本。
- 安装脚本与 npx 共用缓存目录后，两条路径切换不会重复下载。
- 新增一个必须与 CI 同步演进的模块。资产改名的代价从「改三处」变成「改一处 +
  跑冒烟」，但忘记跑冒烟仍会漏。冒烟因此是本决定的必要组成，不是可选项。
- 脚本不装 Agent，意味着一行安装后的首次使用仍需用户准备 Agent。这是 ADR-0060
  的既定后果，不在本 ADR 里翻案。

## Considered Options

- **让 CI 改名去迁就 npx**：否决。已发布 Release 的资产名不可变，改 CI 会让
  旧版本安装路径断裂，且 `linux-x64` 这类命名与 Rust target 三元组的距离更远。
- **脚本内联平台映射表**：否决。这正是第四份副本，本 ADR 要消除的东西。
- **提供 `curl | bash` 直连官网短链**：否决。当前没有可托管该短链的基础设施，
  且它会绕过 GitHub Release 的摘要文件。脚本从 Release 直取。
- **顺带交付 systemd unit / 服务注册**：否决。与「不写系统级目录、不要 root」
  冲突，且 Docker 路径（`docker-compose.yml`，17891）已覆盖常驻部署场景。
