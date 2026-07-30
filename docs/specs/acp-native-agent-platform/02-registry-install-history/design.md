# Design: Registry, Install, Config, MCP, Skills, And History

## Registry Types

```rust
pub enum AgentType {
    ClaudeCode,
    Codex,
    OpenCode,
    Gemini,
    OpenClaw,
    Cline,
    Hermes,
}

pub enum AgentDistribution {
    Npx { package: String, cmd: String, args: Vec<String>, node_required: Option<String> },
    Binary { cmd: String, platforms: Vec<PlatformBinary> },
    Uvx { package: String, cmd: String, args: Vec<String>, python_required: Option<String> },
    System { cmd: String, args: Vec<String> },
}
```

Registry metadata is data-driven. UI should not special-case agent install
commands except for explanatory text.

## Installation

Install/update returns a task-style result:

```text
agent_install
  -> resolve platform
  -> validate prerequisite runtime
  -> download/install or invoke package manager
  -> verify command availability
  -> report version/status
```

Binary installs should use a VibeX-owned cache directory, not arbitrary project
directories. Npx/Uvx installs may use global package installation only when the
registry marks it as safe and expected.

## Config, MCP, Skills

The registry owns config locations and supported surfaces:

```rust
pub struct AgentConfigSurface {
    pub auth_paths: Vec<PathTemplate>,
    pub config_paths: Vec<PathTemplate>,
    pub mcp_strategy: AgentMcpStrategy,
    pub skills_strategy: AgentSkillsStrategy,
}
```

Strategies:

- `Unsupported`
- `FileJson`
- `FileToml`
- `Directory`
- `AgentCommand`
- `AcpExtension`

No single config writer is allowed to treat all agents as equivalent.

## History Import

History import produces `ImportedAgentSession` values, not live session state:

```rust
pub struct ImportedAgentSession {
    pub source_agent: AgentType,
    pub external_session_id: String,
    pub title: Option<String>,
    pub workspace_path: Option<PathBuf>,
    pub messages: Vec<ImportedAgentMessage>,
    pub raw_source_path: Option<PathBuf>,
}
```

The frontend may show imported sessions alongside live sessions, but actions that
resume a session must explicitly create/load an ACP session through the runtime.

## License Handling

For copied third-party files, keep upstream headers and record the source,
revision, license, modified files, and local changes in the appropriate NOTICE.
