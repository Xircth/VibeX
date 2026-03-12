use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentType {
    ClaudeCode,
    Codex,
    OpenCode,
    Auggie,
    Autohand,
    Cline,
    CodebuddyCode,
    CorustAgent,
    Gemini,
    GithubCopilot,
    Goose,
    Junie,
    Qoder,
    QwenCode,
    FactoryDroid,
    Kimi,
    MinionCode,
    MistralVibe,
    OpenClaw,
    Stakpak,
}

impl fmt::Display for AgentType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AgentType::ClaudeCode => write!(f, "Claude Code"),
            AgentType::Codex => write!(f, "Codex CLI"),
            AgentType::OpenCode => write!(f, "OpenCode"),
            AgentType::Auggie => write!(f, "Auggie"),
            AgentType::Autohand => write!(f, "Autohand"),
            AgentType::Cline => write!(f, "Cline"),
            AgentType::CodebuddyCode => write!(f, "Codebuddy Code"),
            AgentType::CorustAgent => write!(f, "Corust Agent"),
            AgentType::Gemini => write!(f, "Gemini CLI"),
            AgentType::GithubCopilot => write!(f, "GitHub Copilot"),
            AgentType::Goose => write!(f, "goose"),
            AgentType::Junie => write!(f, "Junie"),
            AgentType::Qoder => write!(f, "Qoder CLI"),
            AgentType::QwenCode => write!(f, "Qwen Code"),
            AgentType::FactoryDroid => write!(f, "Factory Droid"),
            AgentType::Kimi => write!(f, "Kimi CLI"),
            AgentType::MinionCode => write!(f, "Minion Code"),
            AgentType::MistralVibe => write!(f, "Mistral Vibe"),
            AgentType::OpenClaw => write!(f, "OpenClaw"),
            AgentType::Stakpak => write!(f, "Stakpak"),
        }
    }
}
