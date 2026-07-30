---
status: accepted
date: 2026-07-29
decision-makers:
  - VibeX maintainers
---

# 插件统一绑定托管工具、Skill、提示词工作流与 Artifact Provider

VibeX 将 **Plugin（插件）** 定义为用户可发现、可启用、可审计的一组外接能力，而
不是一段可任意执行的安装命令。一个插件可以声明：

- 一个或多个外部工具依赖，例如 OfficeCLI；
- 一个或多个 Agent Skill；
- 一个或多个提示词模板或快捷工作流，例如“创建 PPT”“分析 Excel”；
- 可选的本地控制台；
- 可选的 Artifact 能力，例如生成、监听和预览 DOCX/XLSX/PPTX。

内置插件与第三方插件使用同一份 manifest 与同一条安装、启用、激活和诊断管线。
“内置”只表示由 VibeX 随应用提供、默认可发现且不可删除；它不允许绕过依赖校验、
版本锁、权限或运行时状态机。Office Work 首先作为内置 Office 插件族落地，
OfficeCLI 在用户首次启用相关插件或首次调用所需动作时自动安装；启用/调用即为本次
安装授权，VibeX 不在应用启动时静默下载。

## 工具依赖与安装所有权

插件 manifest 只能引用声明式 `ToolDependency`，不得继续把任意
`install_command` 当作可信安装契约。每个依赖必须至少声明稳定 id、分发来源、
精确版本、支持平台、安装策略、探测命令和完整性证据。安装产物由 VibeX 放入
版本化托管目录并形成 `ToolInstallationLock`；升级先安装和验证新版本，再原子切换，
失败时保留旧版本。

内置工具必须有预期 SHA-256 或等价生态完整性证据。第三方工具未来若无法提供预期
哈希，必须明确采用首次信任并显示较低信任等级。上述语义复用 ADR-0011、ADR-0016
与 ADR-0017 的所有权、版本锁和完整性原则，但工具安装与 Agent 安装分别持久化，
不得伪装成 Agent installation。

现有插件 v1 的任意全局 shell `install_command` 被本决定取代。迁移时可以读入旧
manifest 并显示诊断，但在用户把它转换为受支持的声明式依赖前，不得自动执行该命令。

## Artifact Tool Provider

`ArtifactToolProvider` 是 VibeX 拥有的运行时接口，用于把已验证工具接入统一的
Artifact 生命周期。Provider 接收已解析的精确工具路径，不自行下载工具，也不拥有
插件安装状态。接口至少覆盖：

```rust
pub trait ArtifactToolProvider: Send + Sync {
    fn descriptor(&self) -> ArtifactProviderDescriptor;
    fn probe(&self, tool: &ResolvedTool) -> Result<ArtifactCapabilities, ArtifactError>;
    fn open_preview(&self, request: OpenArtifactPreview)
        -> Result<ArtifactPreviewLease, ArtifactError>;
    fn close_preview(&self, lease: ArtifactPreviewLease) -> Result<(), ArtifactError>;
}
```

首个实现为 OfficeCLI Provider，复用现有 Office watch 进程管理。文件内容仍由工作区
文件系统持有；VibeX 的 Artifact 记录保存路径、类型、内容哈希、生成者、关联
Conversation/Turn 和修订证据，事件日志记录 Artifact 生命周期引用，不复制或冒充
文件内容本身。

第三方无代码 manifest 只能引用 VibeX 已知的 Provider 类型。允许第三方提供原生
Provider 代码、动态库或任意宿主进程属于未来的签名扩展体系，不在本决定范围内。

## 快捷工作流

插件动作必须保存结构化 Prompt blocks，而不是只保存一段不可解析字符串。动作可以
声明需要的 Skill、工具、输入文件类型、目标 Artifact 类型、建议 Agent 和默认提示词，
但最终发送前仍由用户确认。动作在 Composer、插件侧栏和 Automation 编辑器中复用
同一个 `PluginAction` 定义，避免三个入口分别维护提示词。

## Consequences

- OfficeCLI 的现有检测、安装、watch 与预览代码可以作为迁移输入，但安装路径必须
  收敛到托管工具管线；远程 `curl | shell`/PowerShell 安装不再是最终架构。
- 插件启用状态、工具安装状态、Skill 安装状态和运行时健康状态必须分离，不能再用
  一个 `install_status` 字符串代表全部状态。
- Office Work 的首批内置动作至少覆盖创建/修改 PPTX、创建/修改 DOCX、分析/生成
  XLSX；具体模板可参考 Codeg Office skills，但采用 VibeX 插件 manifest。
- 插件控制台与 Artifact preview 都必须使用租约和显式清理。未来 Web 端访问本地
  preview 时使用短期 capability token，绝不把 Web Server 主 token 交给 iframe。
- 插件 v2 是有意的领域重建；不以保持当前 `plugins` 表和 command 签名为约束。

## Considered Options

- 为“创建 PPT”等功能继续增加硬编码按钮：否决。它会重复安装、提示词、Agent 和
  预览逻辑，也无法被 Automation 复用。
- 让 `ArtifactToolProvider` 同时负责下载与安装：否决。安装信任与运行时能力是两个
  不同生命周期，合并后无法独立升级、验证和诊断。
- 继续允许 manifest 提供任意 shell 安装命令：否决。它不可复现、不可完整性校验，
  还会修改用户全局环境。
